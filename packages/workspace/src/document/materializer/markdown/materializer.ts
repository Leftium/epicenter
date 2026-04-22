import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Type from 'typebox';
import type * as Y from 'yjs';
import { defineMutation } from '../../../shared/actions.js';
import type { MaybePromise } from '../../../shared/types.js';
import type { Kv } from '../../attach-kv.js';
import type { BaseRow, Table } from '../../attach-table.js';
import type { SerializeResult } from './markdown.js';
import { assembleMarkdown } from './markdown.js';
import { parseMarkdownFile } from './parse-markdown-file.js';

// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous kv
type AnyKv = Kv<any>;
// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous tables
type AnyTable = Table<any>;

/**
 * Symmetric shape of a parsed markdown file. `toMarkdown` produces it,
 * `fromMarkdown` consumes it — `Parameters<fromMarkdown>[0]` ≡ `ReturnType<toMarkdown>`.
 */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

type TableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table's files. Default: `table.name`. */
	dir?: string;
	/** Compute the on-disk filename for a row. Default: `${row.id}.md`. */
	filename?: (row: TRow) => MaybePromise<string>;
	/** Produce frontmatter + body for a row. Default: `{ frontmatter: row, body: undefined }`. */
	toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
	/** Parse frontmatter + body back into a row. Default: `parsed.frontmatter as TRow`. */
	fromMarkdown?: (parsed: MarkdownShape) => MaybePromise<TRow>;
};

type KvConfig = {
	/** Serialize the full KV state to a single file. Default: `kv.json` with JSON.stringify. */
	serialize?: (data: Record<string, unknown>) => SerializeResult;
};

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage — variance across heterogeneous row types
	config: TableConfig<any>;
	unsubscribe?: () => void;
};

type RegisteredKv = {
	kv: AnyKv;
	config: KvConfig;
	unsubscribe?: () => void;
};

/** Default filename: `${row.id}.md`. */
const defaultFilename = (row: BaseRow): string => `${row.id}.md`;

/** Default toMarkdown: dump row as frontmatter, no body. */
const defaultToMarkdown = (row: BaseRow): MarkdownShape => ({
	frontmatter: { ...row },
	body: undefined,
});

/** Default fromMarkdown: treat frontmatter as the row. */
const defaultFromMarkdown = (parsed: MarkdownShape): BaseRow =>
	parsed.frontmatter as BaseRow;

/**
 * Default KV serializer: pretty-printed JSON in `kv.json`. Used whenever a
 * registered kv's `config.serialize` isn't provided.
 */
const defaultKvSerialize = (data: Record<string, unknown>): SerializeResult => ({
	filename: 'kv.json',
	content: JSON.stringify(data, null, 2),
});

/**
 * Compose a row into the full on-disk artifact: filename + content string.
 *
 * Resolves the per-slot defaults (`filename`, `toMarkdown`) and runs them
 * through `assembleMarkdown`. Pure except for awaiting caller-supplied promises.
 */
async function rowToMarkdownFile<TRow extends BaseRow>(
	row: TRow,
	config: TableConfig<TRow>,
): Promise<{ filename: string; content: string }> {
	const filenameFn = config.filename ?? defaultFilename;
	const toMarkdownFn = config.toMarkdown ?? defaultToMarkdown;
	const filename = await filenameFn(row);
	const shape = await toMarkdownFn(row);
	const content = assembleMarkdown(shape.frontmatter, shape.body);
	return { filename, content };
}

/**
 * Write a markdown file under `directory`, creating any intermediate
 * subdirectories implied by a filename like `"archive/old.md"`.
 */
async function writeMarkdownFile(
	directory: string,
	filename: string,
	content: string,
): Promise<void> {
	const fullPath = join(directory, filename);
	const parent = dirname(fullPath);
	if (parent !== directory) {
		await mkdir(parent, { recursive: true });
	}
	await writeFile(fullPath, content);
}

/**
 * Create a bidirectional markdown materializer for workspace data.
 *
 * `attachMarkdownMaterializer(ydoc, { dir })` returns a chainable builder where
 * `.table(tableRef, config?)` opts in per table and `.kv(kvRef, config?)` opts
 * in a single KV mirror. Nothing materializes by default.
 *
 * Exposes three mutations:
 * - `push`    — disk → workspace. Import .md files as rows (additive).
 * - `pull`    — workspace → disk. Write every row as .md file (additive).
 * - `rebuild` — workspace → disk, destructive. Clear output dir then rewrite
 *   all rows. Use for orphan cleanup or after config changes.
 *   Matches the sqlite materializer's `rebuild` for cross-materializer parity.
 *
 * Teardown is hooked to the ydoc via `ydoc.once('destroy', ...)` — callers
 * never call a dispose method; destroying the ydoc cascades.
 *
 * @example
 * ```ts
 * const factory = defineDocument((id) => {
 *   const ydoc = new Y.Doc({ guid: id });
 *   const tables = attachTables(ydoc, myTableDefs);
 *   const kv = attachKv(ydoc, myKvDefs);
 *   const idb = attachIndexedDb(ydoc);
 *
 *   const markdown = attachMarkdownMaterializer(ydoc, {
 *     dir: './data',
 *     waitFor: idb.whenLoaded,
 *   })
 *     .table(tables.posts, {
 *       filename: slugFilename('title'),
 *       // Inline toMarkdown / fromMarkdown callbacks when needed —
 *       // most real tables split metadata (on the row) from body
 *       // content (in a separate content-doc via defineDocument).
 *     })
 *     .kv(kv);
 *
 *   return { ydoc, tables, kv, idb, markdown, [Symbol.dispose]() { ydoc.destroy(); } };
 * });
 * ```
 */
export function attachMarkdownMaterializer(
	ydoc: Y.Doc,
	{
		dir,
		waitFor,
	}: {
		/** Base output directory. Accepts a string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
		/**
		 * Gate: the materializer awaits this before the initial filesystem flush.
		 * Matches the `waitFor` convention used by `attachSync`. Omit for no gate.
		 */
		waitFor?: Promise<unknown>;
	},
) {
	const registered = new Map<string, RegisteredTable>();
	let registeredKv: RegisteredKv | undefined;
	let isDisposed = false;
	/**
	 * Closed once `initialize()` commits (past `await waitFor`). Any `.table()`
	 * / `.kv()` call after this throws — the materializer is past the point
	 * where late registrations would be picked up for initial flush.
	 */
	let isRegistrationOpen = true;

	const resolveDir = async () => (typeof dir === 'function' ? await dir() : dir);

	// ── Per-table materialization ───────────────────────────────

	async function materializeTable(
		baseDir: string,
		{ table, config }: RegisteredTable,
	): Promise<() => void> {
		const directory = join(baseDir, config.dir ?? table.name);
		const filenames = new Map<string, string>();

		await mkdir(directory, { recursive: true });

		for (const row of table.getAllValid()) {
			const { filename, content } = await rowToMarkdownFile(row, config);
			await writeMarkdownFile(directory, filename, content);
			filenames.set(row.id, filename);
		}

		// Sequential writes inside the observer avoid rename races — a parallel
		// approach (Promise.allSettled) could delete a file another write needs.
		return table.observe((changedIds) => {
			void (async () => {
				for (const id of changedIds) {
					const { data: row, error } = table.get(id);

					// Invalid or missing → unlink any previously-written file.
					if (error || row === null) {
						const previous = filenames.get(id);
						if (previous) {
							await unlink(join(directory, previous)).catch(() => {});
							filenames.delete(id);
						}
						continue;
					}

					const { filename, content } = await rowToMarkdownFile(row, config);
					const previous = filenames.get(id);
					if (previous && previous !== filename)
						await unlink(join(directory, previous)).catch(() => {});
					await writeMarkdownFile(directory, filename, content);
					filenames.set(id, filename);
				}
			})().catch((error) => {
				console.warn('[markdown-materializer] table write failed:', error);
			});
		});
	}

	async function materializeKv(
		baseDir: string,
		{ kv, config }: RegisteredKv,
	): Promise<() => void> {
		const state: Record<string, unknown> = { ...kv.getAll() };
		const serialize = config.serialize ?? defaultKvSerialize;

		const initial = serialize(state);
		await writeFile(join(baseDir, initial.filename), initial.content);

		return kv.observeAll((changes) => {
			void (async () => {
				for (const [key, change] of changes) {
					if (change.type === 'set') state[key] = change.value;
					else delete state[key];
				}
				const result = serialize(state);
				await writeFile(join(baseDir, result.filename), result.content);
			})().catch((error) => {
				console.warn('[markdown-materializer] kv write failed:', error);
			});
		});
	}

	// ── Disposal ────────────────────────────────────────────────

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		for (const entry of registered.values()) entry.unsubscribe?.();
		registeredKv?.unsubscribe?.();
	}

	ydoc.once('destroy', dispose);

	// ── Initial flush ────────────────────────────────────────────

	async function initialize() {
		// Always yield a microtask so callers can finish synchronous setup
		// (including `.table()` / `.kv()` registrations) before the first flush.
		await waitFor;
		// Close the registration window: any further `.table()` / `.kv()` call
		// throws, even if init errors or disposes mid-flight below.
		isRegistrationOpen = false;
		if (isDisposed) return;

		const baseDir = await resolveDir();
		await mkdir(baseDir, { recursive: true });

		for (const entry of registered.values()) {
			if (isDisposed) return;
			entry.unsubscribe = await materializeTable(baseDir, entry);
		}

		if (registeredKv && !isDisposed) {
			registeredKv.unsubscribe = await materializeKv(baseDir, registeredKv);
		}
	}

	const whenFlushed = initialize();

	// ── Push (imports markdown files into workspace tables) ─────

	async function pushMarkdownFiles(): Promise<{
		imported: number;
		skipped: number;
		errors: string[];
	}> {
		const baseDir = await resolveDir();
		let imported = 0;
		let skipped = 0;
		const errors: string[] = [];

		for (const entry of registered.values()) {
			const directory = join(baseDir, entry.config.dir ?? entry.table.name);

			let files: string[];
			try {
				files = await readdir(directory);
			} catch {
				continue;
			}

			for (const filename of files) {
				if (!filename.endsWith('.md')) continue;

				let content: string;
				try {
					content = await readFile(join(directory, filename), 'utf-8');
				} catch (error) {
					errors.push(`Failed to read ${filename}: ${error}`);
					continue;
				}

				const parsed = parseMarkdownFile(content);
				if (!parsed) {
					skipped++;
					continue;
				}

				try {
					const fromMarkdown = entry.config.fromMarkdown ?? defaultFromMarkdown;
					const row = await fromMarkdown(parsed);
					entry.table.set(row);
					imported++;
				} catch (error) {
					errors.push(`Failed to import ${filename}: ${error}`);
				}
			}
		}

		return { imported, skipped, errors };
	}

	// ── Rebuild (destructive: wipe output dir and re-materialize) ─

	async function rebuildMarkdownFiles(
		tableName?: string,
	): Promise<{ deleted: number; written: number }> {
		const baseDir = await resolveDir();
		let deleted = 0;
		let written = 0;

		const targets =
			tableName !== undefined
				? ([registered.get(tableName)].filter(
						(entry): entry is RegisteredTable => entry !== undefined,
					) as RegisteredTable[])
				: [...registered.values()];

		if (tableName !== undefined && targets.length === 0) {
			throw new Error(
				`Cannot rebuild "${tableName}" — not in the materialized table set.`,
			);
		}

		for (const entry of targets) {
			const directory = join(baseDir, entry.config.dir ?? entry.table.name);

			// Sweep existing .md files
			try {
				const files = await readdir(directory);
				for (const filename of files) {
					if (!filename.endsWith('.md')) continue;
					await unlink(join(directory, filename)).catch(() => {});
					deleted++;
				}
			} catch {
				// Directory doesn't exist yet — fine.
			}

			await mkdir(directory, { recursive: true });
			for (const row of entry.table.getAllValid()) {
				const { filename, content } = await rowToMarkdownFile(row, entry.config);
				await writeMarkdownFile(directory, filename, content);
				written++;
			}
		}

		// Re-materialize KV if registered and this is a full reindex.
		if (tableName === undefined && registeredKv) {
			const { kv, config } = registeredKv;
			const serialize = config.serialize ?? defaultKvSerialize;
			const state = { ...kv.getAll() };
			const result = serialize(state);
			await writeFile(join(baseDir, result.filename), result.content);
			written++;
		}

		return { deleted, written };
	}

	// ── Builder ──────────────────────────────────────────────────

	const api = {
		whenFlushed,
		push: defineMutation({
			title: 'Push markdown to workspace',
			description:
				'Read markdown files from disk and import rows into registered tables',
			input: Type.Object({}),
			handler: pushMarkdownFiles,
		}),
		pull: defineMutation({
			title: 'Pull workspace to markdown',
			description:
				'Re-serialize all valid rows from registered tables to markdown files on disk',
			input: Type.Object({}),
			handler: async () => {
				const baseDir = await resolveDir();
				let written = 0;
				for (const entry of registered.values()) {
					const directory = join(baseDir, entry.config.dir ?? entry.table.name);
					await mkdir(directory, { recursive: true });
					for (const row of entry.table.getAllValid()) {
						const { filename, content } = await rowToMarkdownFile(
							row,
							entry.config,
						);
						await writeMarkdownFile(directory, filename, content);
						written++;
					}
				}
				return { written };
			},
		}),
		rebuild: defineMutation({
			title: 'Rebuild markdown files',
			description:
				'Delete existing .md files in registered table directories and re-serialize all valid rows. Destructive — removes orphan files left by deleted rows or stale configs.',
			input: Type.Object({ table: Type.Optional(Type.String()) }),
			handler: ({ table }) => rebuildMarkdownFiles(table),
		}),
	};

	type MaterializerBuilder = typeof api & {
		/**
		 * Opt in a workspace table for markdown materialization.
		 *
		 * Must be called synchronously after construction, before `whenFlushed`
		 * resolves.
		 */
		table<TRow extends BaseRow>(
			table: Table<TRow>,
			config?: TableConfig<TRow>,
		): MaterializerBuilder;
		/**
		 * Opt in the workspace Kv for markdown materialization. Single file on
		 * disk (default `kv.json`) keeps the full Kv state.
		 *
		 * Must be called synchronously after construction, before `whenFlushed`
		 * resolves.
		 */
		kv(kv: AnyKv, config?: KvConfig): MaterializerBuilder;
	};

	const builder: MaterializerBuilder = {
		...api,
		table(table, config) {
			if (!isRegistrationOpen)
				throw new Error(
					`attachMarkdownMaterializer: .table("${table.name}") called after initial flush. All .table() registrations must happen synchronously after construction.`,
				);
			registered.set(table.name, {
				table: table as AnyTable,
				config: config ?? {},
			});
			return builder;
		},
		kv(kv, config) {
			if (!isRegistrationOpen)
				throw new Error(
					'attachMarkdownMaterializer: .kv() called after initial flush. All .kv() registrations must happen synchronously after construction.',
				);
			registeredKv = {
				kv: kv as AnyKv,
				config: config ?? {},
			};
			return builder;
		},
	};

	return builder;
}
