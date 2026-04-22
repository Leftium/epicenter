import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Type from 'typebox';
import type * as Y from 'yjs';
import { defineMutation } from '../../../shared/actions.js';
import type { MaybePromise } from '../../../shared/types.js';
import type { BaseRow, Kv, Table } from '../../index.js';
import type { SerializeResult } from './markdown.js';
import { toMarkdown } from './markdown.js';
import { parseMarkdownFile } from './parse-markdown-file.js';

// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous kv
type AnyKv = Kv<any>;
// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous tables
type AnyTable = Table<any>;

type TableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table's files. Default: `table.name`. */
	dir?: string;
	/** Produce the on-disk filename + content for a row. Default: `{id}.md` with toMarkdown. */
	serialize?: (row: TRow) => MaybePromise<SerializeResult>;
	/** Parse a markdown file back into a row. Required for `push` if custom shape. */
	deserialize?: (parsed: {
		frontmatter: Record<string, unknown>;
		body: string | undefined;
	}) => MaybePromise<TRow>;
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

/**
 * Create a bidirectional markdown materializer for workspace data.
 *
 * `attachMarkdownMaterializer(ydoc, { dir })` returns a chainable builder where
 * `.table(tableRef, config?)` opts in per table and `.kv(kvRef, config?)` opts
 * in a single KV mirror. Nothing materializes by default.
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
 *     .table(tables.posts, { serialize: slugFilename('title') })
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
	let hasInitialized = false;

	const resolveDir = async () => (typeof dir === 'function' ? await dir() : dir);

	// ── Per-table materialization ───────────────────────────────

	async function materializeTable(
		baseDir: string,
		{ table, config }: RegisteredTable,
	): Promise<() => void> {
		const directory = join(baseDir, config.dir ?? table.name);
		const filenames = new Map<string, string>();
		const serialize: (row: BaseRow) => MaybePromise<SerializeResult> =
			config.serialize ??
			((row) => ({
				filename: `${row.id}.md`,
				content: toMarkdown({ ...row }),
			}));

		await mkdir(directory, { recursive: true });

		for (const row of table.getAllValid()) {
			const result = await serialize(row);
			await writeFile(join(directory, result.filename), result.content);
			filenames.set(row.id, result.filename);
		}

		// Sequential writes inside the observer avoid rename races — a parallel
		// approach (Promise.allSettled) could delete a file another write needs.
		return table.observe((changedIds) => {
			void (async () => {
				for (const id of changedIds) {
					const getResult = table.get(id);

					if (getResult.status === 'not_found') {
						const previous = filenames.get(id);
						if (previous) {
							await unlink(join(directory, previous)).catch(() => {});
							filenames.delete(id);
						}
						continue;
					}

					if (getResult.status !== 'valid') continue;

					const result = await serialize(getResult.row);
					const previous = filenames.get(id);
					if (previous && previous !== result.filename)
						await unlink(join(directory, previous)).catch(() => {});
					await writeFile(join(directory, result.filename), result.content);
					filenames.set(id, result.filename);
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
		const serialize =
			config.serialize ??
			((data: Record<string, unknown>) => ({
				filename: 'kv.json',
				content: JSON.stringify(data, null, 2),
			}));

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

	const whenFlushed = (async () => {
		// Always yield a microtask so callers can finish synchronous setup
		// (including `.table()` / `.kv()` registrations) before the first flush.
		await waitFor;
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

		hasInitialized = true;
	})();

	// ── Imperative methods (push / pull) ────────────────────────

	async function pushImpl(): Promise<{
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
					const deserialize =
						entry.config.deserialize ??
						((p: { frontmatter: Record<string, unknown> }) =>
							p.frontmatter as BaseRow);
					const row = await deserialize(parsed);
					entry.table.set(row);
					imported++;
				} catch (error) {
					errors.push(`Failed to import ${filename}: ${error}`);
				}
			}
		}

		return { imported, skipped, errors };
	}

	async function pullImpl(): Promise<{ written: number }> {
		const baseDir = await resolveDir();
		let written = 0;

		for (const entry of registered.values()) {
			const directory = join(baseDir, entry.config.dir ?? entry.table.name);
			const serialize: (row: BaseRow) => MaybePromise<SerializeResult> =
				entry.config.serialize ??
				((row) => ({
					filename: `${row.id}.md`,
					content: toMarkdown({ ...row }),
				}));

			await mkdir(directory, { recursive: true });
			for (const row of entry.table.getAllValid()) {
				const result = await serialize(row);
				await writeFile(join(directory, result.filename), result.content);
				written++;
			}
		}

		return { written };
	}

	// ── Builder ──────────────────────────────────────────────────

	const api = {
		whenFlushed,
		push: defineMutation({
			title: 'Push markdown to workspace',
			description:
				'Read markdown files from disk and import rows into registered tables',
			input: Type.Object({}),
			handler: () => pushImpl(),
		}),
		pull: defineMutation({
			title: 'Pull workspace to markdown',
			description:
				'Re-serialize all valid rows from registered tables to markdown files on disk',
			input: Type.Object({}),
			handler: () => pullImpl(),
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
			if (hasInitialized)
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
			if (hasInitialized)
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
