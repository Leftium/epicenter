import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Value } from 'typebox/value';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { tryAsync } from 'wellcrafted/result';
import type * as Y from 'yjs';
import { convertEpicenterLinksToWikilinks } from '../../../links.js';
import { assembleMarkdown } from '../../../markdown/assemble-markdown.js';
import { parseMarkdownFile } from '../../../markdown/parse-markdown-file.js';
import type { MaybePromise } from '../../../shared/types.js';
import type { Kv } from '../../attach-kv.js';
import {
	type BaseRow,
	type Table,
	TableParseError,
} from '../../attach-table.js';

// ════════════════════════════════════════════════════════════════════════════
// PUSH ERROR + EVENT TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced by the background write-observer (table row → .md file,
 * KV state → serialized file). These run inside `.catch(...)` of a detached
 * async task, so they ship to the logger, not through a Result to the caller.
 * File-local: never crosses the module boundary.
 */
const MaterializerWriteError = defineErrors({
	TableWriteFailed: ({
		tableName,
		cause,
	}: {
		tableName: string;
		cause: unknown;
	}) => ({
		message: `[markdown-materializer] table write failed for "${tableName}": ${extractErrorMessage(cause)}`,
		tableName,
		cause,
	}),
	KvWriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `[markdown-materializer] kv write failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export const MaterializerPushError = defineErrors({
	/** Reading the file from disk failed. */
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The caller-supplied `fromMarkdown` callback threw. */
	FromMarkdownCallbackFailed: ({ cause }: { cause: unknown }) => ({
		message: `fromMarkdown callback threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MaterializerPushError = InferErrors<typeof MaterializerPushError>;

/**
 * A single event emitted during `push`. Three kinds:
 *
 * - **`imported`**: the file was read, parsed, validated, and its row set.
 * - **`skipped`**: the file couldn't be parsed as markdown-with-frontmatter
 *   (no `---` delimiters, empty delimiters, or frontmatter that doesn't
 *   decode to an object). The three cases collapse at the parser boundary
 *   into a single "not a note" decision; no discriminator needed.
 * - **`error`**: something failed. `error.name` discriminates between
 *   `ReadFailed` / `FromMarkdownCallbackFailed` (materializer errors) and
 *   `ValidationFailed` / `MigrationFailed` / `AsyncSchemaNotSupported`
 *   (table parse errors).
 *
 * `path` is the relative path from the materializer's base `dir` (e.g.,
 * `"posts/hello.md"` for a file under `config.dir: 'posts'`). Not the
 * bare filename: two tables writing the same filename would be
 * indistinguishable otherwise.
 */
export type PushEvent =
	| { kind: 'imported'; path: string; tableName: string; id: string }
	| { kind: 'skipped'; path: string }
	| {
			kind: 'error';
			path: string;
			tableName: string;
			error: MaterializerPushError | TableParseError;
	  };

/** Aggregated result of one `push` invocation. */
export type PushResult = {
	imported: number;
	skipped: number;
	errored: number;
	events: PushEvent[];
};

// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous kv
type AnyKv = Kv<any>;
// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous tables
type AnyTable = Table<any>;

/**
 * Symmetric shape of a parsed markdown file. `toMarkdown` produces it,
 * `fromMarkdown` consumes it: `Parameters<fromMarkdown>[0]` ≡ `ReturnType<toMarkdown>`.
 */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

export type MarkdownTableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table's files. Default: `table.name`. */
	dir?: string;
	/** Compute the on-disk filename for a row. Default: `${row.id}.md`. */
	filename?: (row: TRow) => MaybePromise<string>;
	/** Produce frontmatter + body for a row. Default: `{ frontmatter: row, body: undefined }`. */
	toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
	/** Parse frontmatter + body back into a row. Default: `parsed.frontmatter as TRow`. */
	fromMarkdown?: (parsed: MarkdownShape) => MaybePromise<TRow>;
};

export type MarkdownKvConfig = {
	/** Serialize the full KV state to a single file. Default: `kv.json` with JSON.stringify. */
	serialize?: (data: Record<string, unknown>) => {
		filename: string;
		content: string;
	};
};

/**
 * One element of the materializer's `tables` option. Either a bare table
 * reference (when no per-table config is needed) or a `[table, config]`
 * tuple. `config` narrows per entry so `filename: (row) => row.title`
 * sees the specific row type.
 */
export type MarkdownTableEntry<TRow extends BaseRow> =
	| Table<TRow>
	| readonly [Table<TRow>, MarkdownTableConfig<TRow>?];

/**
 * Variadic mapped type over a tuple of row types. Each element of the
 * outer tuple is `MarkdownTableEntry<Rows[K]>`, so the row type is inferred
 * per entry from the table reference.
 */
export type MarkdownTableEntries<TRows extends readonly BaseRow[]> = {
	[K in keyof TRows]: MarkdownTableEntry<TRows[K]>;
};

/**
 * The `kv` option: either a bare Kv reference or a `[kv, config]` tuple.
 * Single value (not an array of entries), because the markdown materializer
 * mirrors at most one KV per workspace.
 */
export type MarkdownKvEntry = AnyKv | readonly [AnyKv, MarkdownKvConfig?];

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage, variance across heterogeneous row types
	config: MarkdownTableConfig<any>;
	unsubscribe?: () => void;
};

type RegisteredKv = {
	kv: AnyKv;
	config: MarkdownKvConfig;
	unsubscribe?: () => void;
};

/** Default filename: `${row.id}.md`. */
const defaultFilename = (row: BaseRow): string => `${row.id}.md`;

/** Default toMarkdown: dump row as frontmatter, no body. */
const defaultToMarkdown = (row: BaseRow) =>
	({
		frontmatter: { ...row },
		body: undefined,
	}) satisfies MarkdownShape;

/** Default fromMarkdown: treat frontmatter as the row. */
const defaultFromMarkdown = (parsed: MarkdownShape): BaseRow =>
	parsed.frontmatter as BaseRow;

/**
 * Default KV serializer: pretty-printed JSON in `kv.json`. Used whenever a
 * registered kv's `config.serialize` isn't provided.
 */
const defaultKvSerialize = (data: Record<string, unknown>) => ({
	filename: 'kv.json',
	content: JSON.stringify(data, null, 2),
});

/**
 * Compose a row into the full on-disk artifact: filename + content string.
 *
 * Resolves the per-slot defaults (`filename`, `toMarkdown`), rewrites
 * `epicenter://` body links to `[[wikilinks]]` so on-disk notes stay
 * portable, and runs the result through `assembleMarkdown`. Pure except for
 * awaiting caller-supplied promises.
 */
async function rowToMarkdownFile<TRow extends BaseRow>(
	row: TRow,
	config: MarkdownTableConfig<TRow>,
): Promise<{ filename: string; content: string }> {
	const filenameFn = config.filename ?? defaultFilename;
	const toMarkdownFn = config.toMarkdown ?? defaultToMarkdown;
	const filename = await filenameFn(row);
	const shape = await toMarkdownFn(row);
	const body =
		shape.body !== undefined
			? convertEpicenterLinksToWikilinks(shape.body)
			: undefined;
	const content = assembleMarkdown(shape.frontmatter, body);
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
 * Tables and (optionally) a KV are passed as options; nothing materializes
 * until they're listed in `tables` / `kv`.
 *
 * Exposes three mutations:
 * - `push`: disk → workspace. Import .md files as rows (additive).
 * - `pull`: workspace → disk. Write every row as .md file (additive).
 * - `rebuild`: workspace → disk, destructive. Clear output dir then rewrite
 *   all rows. Use for orphan cleanup or after config changes.
 *   Matches the sqlite materializer's `rebuild` for cross-materializer parity.
 *
 * Teardown is hooked to the ydoc via `ydoc.once('destroy', ...)`; callers
 * never call a dispose method; destroying the ydoc cascades.
 *
 * @example
 * ```ts
 * const ydoc = new Y.Doc({ guid: 'workspace' });
 * const tables = attachTables(ydoc, myTableDefs);
 * const kv = attachKv(ydoc, myKvDefs);
 * const idb = attachIndexedDb(ydoc);
 *
 * const markdown = attachMarkdownMaterializer(ydoc, {
 *   dir: './data',
 *   waitFor: idb.whenLoaded,
 *   tables: [
 *     [tables.posts, { filename: slugFilename('title') }],
 *     tables.devices,
 *   ],
 *   kv,
 * });
 * ```
 */
export function attachMarkdownMaterializer<
	const TRows extends readonly BaseRow[],
>(
	ydoc: Y.Doc,
	{
		dir,
		tables,
		kv,
		waitFor,
		log = createLogger('markdown-materializer'),
	}: {
		/** Base output directory. Accepts a string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
		/**
		 * Workspace tables to materialize. Each entry is either the table
		 * reference directly (no per-table config) or a `[table, config]` tuple.
		 * Per-table `filename` / `toMarkdown` / `fromMarkdown` callbacks see the
		 * row's specific type.
		 */
		tables: MarkdownTableEntries<TRows>;
		/**
		 * Optional KV to materialize as a single on-disk file. Pass the Kv
		 * directly or as `[kv, config]` for serializer overrides.
		 */
		kv?: MarkdownKvEntry;
		/**
		 * Gate: the materializer awaits this before the initial filesystem flush.
		 * Matches the `waitFor` convention used by `openCollaboration`. Omit for
		 * no gate.
		 */
		waitFor?: Promise<unknown>;
		/**
		 * Logger for background write-observer failures (table row → file,
		 * KV state → file). Defaults to a console-backed logger.
		 */
		log?: Logger;
	},
) {
	const registered = new Map<string, RegisteredTable>();
	for (const entry of tables) {
		const [table, config] = Array.isArray(entry)
			? (entry as readonly [AnyTable, MarkdownTableConfig<BaseRow>?])
			: ([entry as AnyTable, undefined] as const);
		registered.set(table.name, {
			table,
			config: config ?? {},
		});
	}

	let registeredKv: RegisteredKv | undefined;
	if (kv) {
		const [kvRef, kvConfig] = Array.isArray(kv)
			? (kv as readonly [AnyKv, MarkdownKvConfig?])
			: ([kv as AnyKv, undefined] as const);
		registeredKv = { kv: kvRef, config: kvConfig ?? {} };
	}

	let isDisposed = false;

	const resolveDir = async () =>
		typeof dir === 'function' ? await dir() : dir;

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

		// Sequential writes inside the observer avoid rename races; a parallel
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
			})().catch((cause) => {
				log.warn(
					MaterializerWriteError.TableWriteFailed({
						tableName: table.name,
						cause,
					}),
				);
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
			})().catch((cause) => {
				log.warn(MaterializerWriteError.KvWriteFailed({ cause }));
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
	}

	const whenFlushed = initialize();

	// ── Push (imports markdown files into workspace tables) ─────

	async function pushMarkdownFiles(): Promise<PushResult> {
		const baseDir = await resolveDir();
		const events: PushEvent[] = [];

		for (const entry of registered.values()) {
			const tableName = entry.table.name;
			const subdir = entry.config.dir ?? tableName;
			const directory = join(baseDir, subdir);

			let files: string[];
			try {
				files = await readdir(directory);
			} catch {
				continue; // whole directory missing → silently skip the table
			}

			for (const filename of files) {
				if (!filename.endsWith('.md')) continue;

				// Relative to the materializer's base dir; disambiguates two
				// tables writing files with the same name.
				const path = join(subdir, filename);

				// 1. Read
				const { data: content, error: readError } = await tryAsync({
					try: () => readFile(join(directory, filename), 'utf-8'),
					catch: (cause) => MaterializerPushError.ReadFailed({ cause }),
				});
				if (readError) {
					events.push({ kind: 'error', path, tableName, error: readError });
					continue;
				}

				// 2. Parse frontmatter
				const parsed = parseMarkdownFile(content);
				if (!parsed) {
					events.push({ kind: 'skipped', path });
					continue;
				}

				// 3. Run user's fromMarkdown (or default), capture throws as errors
				const fromMarkdown: (p: MarkdownShape) => MaybePromise<BaseRow> =
					entry.config.fromMarkdown ?? defaultFromMarkdown;
				const { data: row, error: callbackError } = await tryAsync({
					try: async () => fromMarkdown(parsed),
					catch: (cause) =>
						MaterializerPushError.FromMarkdownCallbackFailed({ cause }),
				});
				if (callbackError) {
					events.push({ kind: 'error', path, tableName, error: callbackError });
					continue;
				}
				// tryAsync invariant: row is non-null once error is null; satisfies TS.
				if (row == null) continue;

				// 4. Validate the returned row against the latest schema.
				//    `fromMarkdown` returns a user-facing row (no `_v`); validate
				//    directly against the latest version's TObject.
				const rowId = row.id;
				const latestSchema = entry.table.schema;
				if (!Value.Check(latestSchema, row)) {
					const errors = [...Value.Errors(latestSchema, row)].map((e) => ({
						path: e.instancePath,
						message: e.message,
					}));
					const { error: validationError } = TableParseError.ValidationFailed({
						id: rowId,
						errors,
						row,
					});
					events.push({
						kind: 'error',
						path,
						tableName,
						error: validationError,
					});
					continue;
				}

				// 5. Commit
				entry.table.set(row);
				events.push({ kind: 'imported', path, tableName, id: rowId });
			}
		}

		let imported = 0;
		let skipped = 0;
		let errored = 0;
		for (const event of events) {
			switch (event.kind) {
				case 'imported':
					imported++;
					break;
				case 'skipped':
					skipped++;
					break;
				case 'error':
					errored++;
					break;
				default:
					event satisfies never;
			}
		}

		return { imported, skipped, errored, events };
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
				`Cannot rebuild "${tableName}": not in the materialized table set.`,
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
				// Directory doesn't exist yet. Fine.
			}

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

	// ── Pull (workspace → disk, additive) ────────────────────────

	async function pullMarkdownFiles(): Promise<{ written: number }> {
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
	}

	return {
		whenFlushed,
		/** Read markdown files from disk and import rows into registered tables. */
		push: pushMarkdownFiles,
		/** Re-serialize all valid rows from registered tables to markdown files on disk. */
		pull: pullMarkdownFiles,
		/**
		 * Delete existing `.md` files in registered table directories and
		 * re-serialize all valid rows. Destructive: removes orphan files left by
		 * deleted rows or stale configs.
		 */
		rebuild: rebuildMarkdownFiles,
	};
}
