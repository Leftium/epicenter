import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';
import { Type } from 'typebox';
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
import { defineActions, defineMutation } from '../../../shared/actions.js';
import type { MaybePromise } from '../../../shared/types.js';
import { type BaseRow, type Table, TableParseError } from '../../table.js';
import type { AnyTable, TablesRecord } from '../shared.js';

// ════════════════════════════════════════════════════════════════════════════
// PUSH ERROR + EVENT TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced by the background write-observer (table row → .md file).
 * These run inside `.catch(...)` of a detached async task, so they ship to
 * the logger, not through a Result to the caller. File-local: never crosses
 * the module boundary.
 */
const MaterializerWriteError = defineErrors({
	TableWriteFailed: ({
		tableName,
		id,
		cause,
	}: {
		tableName: string;
		id?: string;
		cause: unknown;
	}) => ({
		message: `[markdown-materializer] table write failed for "${tableName}"${id ? ` (row "${id}")` : ''}: ${extractErrorMessage(cause)}`,
		tableName,
		id,
		cause,
	}),
});

const GitAutosaveError = defineErrors({
	GitAddFailed: ({ stderr }: { stderr: string }) => ({
		message: `git autosave: git add failed: ${stderr.trim()}`,
		stderr,
	}),
	GitCommitFailed: ({ stderr }: { stderr: string }) => ({
		message: `git autosave: git commit failed: ${stderr.trim()}`,
		stderr,
	}),
	EnablementCheckFailed: ({ cause }: { cause: unknown }) => ({
		message: `git autosave: enablement check failed: ${extractErrorMessage(cause)}`,
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

export const MaterializerApplyError = defineErrors({
	/** Two files on disk declare the same row `id`; the reconcile can't pick one. */
	DuplicateId: ({ id, paths }: { id: string; paths: [string, string] }) => ({
		message: `Two files declare id "${id}": ${paths.join(' and ')}. Remove one before applying.`,
		id,
		paths,
	}),
	/**
	 * The table customizes `toMarkdown` but provides no `fromMarkdown`, so apply
	 * cannot prove it round-trips (e.g. fuji writes a body its parser would drop).
	 * Refusing is the safe move: a silently-discarded body is data loss.
	 */
	RoundTripUnproven: ({ tableName }: { tableName: string }) => ({
		message: `Table "${tableName}" customizes toMarkdown but has no fromMarkdown; markdown_apply cannot round-trip it without silently dropping data. Add a fromMarkdown to enable apply for this table.`,
		tableName,
	}),
});
export type MaterializerApplyError = InferErrors<typeof MaterializerApplyError>;

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

/**
 * Outcome of reading one `.md` file: a validated row, a non-note (skipped), or
 * a failure. Shared by `push` (commit each row) and `apply` (diff the set).
 */
type ReadResult =
	| { kind: 'row'; id: string; row: BaseRow; path: string }
	| { kind: 'skipped'; path: string }
	| {
			kind: 'error';
			path: string;
			tableName: string;
			error: MaterializerPushError | TableParseError;
	  };

/**
 * The diff `markdown_apply` computes between the on-disk file set (desired) and
 * the live valid rows (current), keyed by row `id`. When `refused` is true a
 * guard tripped and NOTHING was applied; the plan still reports what would have
 * happened. `creates`/`updates`/`deletes` carry ids only; `skipped`/`errors`
 * carry the offending file path so a caller can surface them.
 */
export type ApplyPlan = {
	refused: boolean;
	reason?: string;
	creates: { tableName: string; id: string }[];
	updates: { tableName: string; id: string }[];
	deletes: { tableName: string; id: string }[];
	skipped: { path: string }[];
	errors: { path: string; tableName: string; error: unknown }[];
};

/**
 * Default ceiling on deletes in one `markdown_apply`. A run that would remove
 * more rows than this refuses and reports the plan instead, so a stale or
 * partial checkout cannot wipe a workspace. Raise per-call via `maxDeletes`.
 */
const DEFAULT_MAX_DELETES = 10;

/**
 * Symmetric shape of a parsed markdown file. `toMarkdown` produces it,
 * `fromMarkdown` consumes it: `Parameters<fromMarkdown>[0]` ≡ `ReturnType<toMarkdown>`.
 */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

/**
 * Per-table customization slot for the markdown materializer. Each field is
 * optional; omitted fields fall back to the module-level defaults.
 */
export type MarkdownTableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table's files. Default: `table.name`. */
	dir?: string;
	/** Compute the on-disk filename for a row. Default: `${row.id}.md`. */
	filename?: (row: TRow) => MaybePromise<string>;
	/** Produce frontmatter + body for a row. Default: `{ frontmatter: row, body: undefined }`. */
	toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
	/**
	 * Parse frontmatter + body back into a row. Default: `parsed.frontmatter as TRow`.
	 *
	 * For `markdown_apply` to be stable, this must be the exact inverse of
	 * `toMarkdown`: a materialize-then-parse round trip has to reproduce the same
	 * row, or apply reads every run as a spurious update. In particular keep
	 * nullable columns symmetric (emit and parse `null`, do not drop the key),
	 * since `Value.Equal` treats `null` and missing as different.
	 */
	fromMarkdown?: (parsed: MarkdownShape) => MaybePromise<TRow>;
	/**
	 * How `markdown_apply` removes a row whose `.md` file disappeared from disk.
	 * Default: hard `table.delete(id)`. Pass a soft-delete (e.g. set `deletedAt`)
	 * for tables that keep tombstones, so the removal still syncs to peers.
	 * Must be synchronous so apply can run every write inside one Yjs
	 * transaction (atomic, single propagated update).
	 */
	onDelete?: (id: string) => void;
};

/**
 * Mapped per-table config keyed by `workspace.tables`. Each value sees the
 * right row type for its callbacks. Keys outside `workspace.tables` are
 * rejected at the type level. Presence here is also the selection: tables
 * not named in this record are not mirrored.
 */
export type PerTableConfig<TTables extends TablesRecord> = {
	[K in keyof TTables]?: TTables[K] extends Table<infer TRow>
		? MarkdownTableConfig<TRow>
		: never;
};

export type GitAutosaveConfig = {
	author?: { name: string; email: string };
	quietMs?: number;
	maxBatchMs?: number;
};

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage, variance across heterogeneous row types
	config: MarkdownTableConfig<any>;
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
 * Read one `.md` file into a validated row. The disk-to-row half shared by
 * `push` (which then commits each row) and `apply` (which diffs the set):
 * read, parse frontmatter, run `fromMarkdown`, validate against the latest
 * schema. Never mutates the table. `path` is relative to the materializer base
 * so two tables writing the same filename stay distinguishable.
 */
async function readTableFile(
	entry: RegisteredTable,
	directory: string,
	subdir: string,
	filename: string,
): Promise<ReadResult> {
	const tableName = entry.table.name;
	const path = join(subdir, filename);

	const { data: content, error: readError } = await tryAsync({
		try: () => readFile(join(directory, filename), 'utf-8'),
		catch: (cause) => MaterializerPushError.ReadFailed({ cause }),
	});
	if (readError) return { kind: 'error', path, tableName, error: readError };

	const parsed = parseMarkdownFile(content);
	if (!parsed) return { kind: 'skipped', path };

	const fromMarkdown: (p: MarkdownShape) => MaybePromise<BaseRow> =
		entry.config.fromMarkdown ?? defaultFromMarkdown;
	const { data: row, error: callbackError } = await tryAsync({
		try: async () => fromMarkdown(parsed),
		catch: (cause) =>
			MaterializerPushError.FromMarkdownCallbackFailed({ cause }),
	});
	if (callbackError)
		return { kind: 'error', path, tableName, error: callbackError };
	if (row == null) return { kind: 'skipped', path };

	// Strip any frontmatter key not in the schema BEFORE validating or storing.
	// TypeBox objects allow additional properties, so without this a hand-edited
	// file could smuggle arbitrary keys (including a literal `__proto__`) into the
	// stored row, and unknown keys would also churn every apply as a false diff.
	const latestSchema = entry.table.schema;
	const cleaned = Value.Clean(latestSchema, row) as BaseRow;

	// Capture id before the type guard: a failed `Value.Check` narrows the value
	// to `never` in its false branch, so `.id` is unreachable inside the block.
	const rowId = cleaned.id;
	if (!Value.Check(latestSchema, cleaned)) {
		const errors = [...Value.Errors(latestSchema, cleaned)].map((e) => ({
			path: e.instancePath,
			message: e.message,
		}));
		const { error: validationError } = TableParseError.ValidationFailed({
			id: rowId,
			errors,
			row: cleaned,
		});
		return { kind: 'error', path, tableName, error: validationError };
	}

	return { kind: 'row', id: rowId, row: cleaned, path };
}

/**
 * Best-effort unlink. Returns `true` when the file actually went away (so the
 * observer can emit `unlinked`); `false` when it was already missing or the
 * remove failed.
 */
async function tryUnlink(
	directory: string,
	filename: string,
): Promise<boolean> {
	try {
		await unlink(join(directory, filename));
		return true;
	} catch {
		return false;
	}
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
 * `perTable[name]` presence is the selection: tables whose name appears in
 * `perTable` are mirrored as a directory of .md files; tables without a
 * `perTable` entry are skipped. To mirror with defaults, pass an empty
 * config (`perTable: { notes: {} }`).
 *
 * Exposes three mutations under `.actions`, each ready to spread into a
 * workspace's action registry:
 * - `markdown_push`: disk to workspace. Import .md files as rows (additive).
 * - `markdown_pull`: workspace to disk. Write every row as .md file (additive).
 * - `markdown_rebuild`: workspace to disk, destructive. Clear output dir then
 *   rewrite all rows. Use for orphan cleanup or after config changes.
 *   Mirrors the sqlite materializer's `rebuild` for cross-materializer parity.
 *
 * Teardown is hooked to `workspace.ydoc` via `once('destroy', ...)`; callers
 * never call a dispose method; destroying the workspace cascades.
 *
 * @example
 * ```ts
 * using workspace = createMyWorkspace({...});
 * const idb = attachIndexedDb(workspace.ydoc);
 *
 * const markdown = attachMarkdownMaterializer(workspace, {
 *   dir: './data',
 *   waitFor: idb.whenLoaded,
 *   perTable: {
 *     posts: { filename: slugFilename('title') },
 *     // Tables not listed here are skipped. Inline toMarkdown / fromMarkdown
 *     // callbacks when needed: most real tables split metadata (on the row)
 *     // from body content (in a separate content-doc).
 *   },
 * });
 * ```
 */
export function attachMarkdownMaterializer<TTables extends TablesRecord>(
	workspace: { ydoc: Y.Doc; tables: TTables },
	{
		dir,
		perTable,
		waitFor,
		log = createLogger('markdown-materializer'),
		git,
	}: {
		/** Base output directory. Accepts a string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
		/**
		 * Per-table customization keyed by `workspace.tables` name. Presence
		 * selects: only tables named in this record are mirrored. Each entry
		 * can override `dir`, `filename`, `toMarkdown`, and `fromMarkdown`;
		 * omit fields for defaults. Pass `{}` for an entry to mirror with all
		 * defaults.
		 */
		perTable?: PerTableConfig<TTables>;
		/**
		 * Gate: the materializer awaits this before the initial filesystem flush.
		 * Matches the `waitFor` convention used by `openCollaboration`. Omit for
		 * no gate.
		 */
		waitFor?: Promise<unknown>;
		/**
		 * Logger for background write-observer failures (table row to file).
		 * Defaults to a console-backed logger.
		 */
		log?: Logger;
		/** Enables Git autosave for files written by this materializer. */
		git?: GitAutosaveConfig;
	},
) {
	const { ydoc, tables } = workspace;
	const registered = new Map<string, RegisteredTable>();
	for (const [name, table] of Object.entries(tables)) {
		const config = (
			perTable as Record<string, MarkdownTableConfig<BaseRow>> | undefined
		)?.[name];
		if (config === undefined) continue;
		registered.set(name, { table: table as AnyTable, config });
	}
	let isDisposed = false;

	const resolveDir = async () =>
		typeof dir === 'function' ? await dir() : dir;

	const gitAutosave = git
		? createGitAutosave({ dir: resolveDir, config: git, log })
		: undefined;
	const markDirty = (path: string): void => {
		gitAutosave?.enqueue(path);
	};

	// ── Per-table materialization ───────────────────────────────

	async function materializeTable(
		baseDir: string,
		{ table, config }: RegisteredTable,
	): Promise<() => void> {
		const directory = join(baseDir, config.dir ?? table.name);
		const filenames = new Map<string, string>();

		await mkdir(directory, { recursive: true });

		// Write one valid row to disk, shared by the initial flush and the live
		// observer. The rename branch is a no-op on first write (`filenames`
		// starts empty), so both paths run this exact code.
		//
		// Only CONTENT PRODUCTION is guarded: a throwing `toMarkdown` (e.g. fuji's
		// body read hitting its connect deadline) skips this one row and leaves its
		// existing `.md` intact, instead of aborting the rest of the flush or the
		// observe batch. A real filesystem write failure (ENOSPC, EACCES) is NOT
		// swallowed here: it propagates, so the initial flush rejects `whenFlushed`
		// and the observer's outer catch surfaces it, rather than reporting success
		// while writing nothing.
		async function writeRow(id: string, row: BaseRow): Promise<void> {
			let rendered: { filename: string; content: string };
			try {
				rendered = await rowToMarkdownFile(row, config);
			} catch (cause) {
				log.warn(
					MaterializerWriteError.TableWriteFailed({
						tableName: table.name,
						id,
						cause,
					}),
				);
				return;
			}
			const { filename, content } = rendered;
			const previous = filenames.get(id);
			if (previous && previous !== filename) {
				const removed = await tryUnlink(directory, previous);
				if (removed) markDirty(join(directory, previous));
			}
			await writeMarkdownFile(directory, filename, content);
			filenames.set(id, filename);
			markDirty(join(directory, filename));
		}

		for (const row of table.getAllValid()) {
			await writeRow(row.id, row);
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
							const removed = await tryUnlink(directory, previous);
							filenames.delete(id);
							if (removed) markDirty(join(directory, previous));
						}
						continue;
					}

					await writeRow(id, row);
				}
			})().catch((cause) => {
				// Reached only by a genuine failure `writeRow` does not swallow: a
				// filesystem write error, or an unexpected throw in the loop
				// scaffolding. A `toMarkdown` failure is already handled per-row and
				// does not land here.
				log.warn(
					MaterializerWriteError.TableWriteFailed({
						tableName: table.name,
						cause,
					}),
				);
			});
		});
	}

	// ── Disposal ────────────────────────────────────────────────

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		gitAutosave?.dispose();
		for (const entry of registered.values()) entry.unsubscribe?.();
	}

	ydoc.once('destroy', dispose);

	// ── Initial flush ────────────────────────────────────────────

	async function initialize() {
		// Always yield a microtask so callers can seed `.set()` writes between
		// construction and `await whenFlushed` before the first filesystem flush.
		await waitFor;
		if (isDisposed) return;

		const baseDir = await resolveDir();
		await mkdir(baseDir, { recursive: true });
		await gitAutosave?.initialize();

		for (const entry of registered.values()) {
			if (isDisposed) return;
			entry.unsubscribe = await materializeTable(baseDir, entry);
		}
	}

	const whenFlushed = initialize();

	// ── Disk read (shared by push + apply) ──────────────────────

	// Read every `.md` under one table's directory into validated rows. `present`
	// distinguishes a MISSING directory (cannot be read, so it carries no
	// desired-state signal) from an EMPTY one (read fine, genuinely zero files):
	// `apply` must not treat "directory gone" as "delete every row".
	//
	// Recursive so it stays symmetric with the write side: `filename` callbacks
	// (and `writeMarkdownFile`) may nest into subdirectories, so a one-level scan
	// would miss those files and `apply` would then read them as deletes.
	async function readTableDir(
		entry: RegisteredTable,
	): Promise<{ present: boolean; results: ReadResult[] }> {
		const baseDir = await resolveDir();
		const subdir = entry.config.dir ?? entry.table.name;
		const directory = join(baseDir, subdir);

		let entries: string[];
		try {
			entries = await readdir(directory, { recursive: true });
		} catch (cause) {
			// Only a genuinely absent directory is "no signal". A permission or IO
			// error must surface, not be mistaken for "delete everything".
			if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return { present: false, results: [] };
			}
			throw cause;
		}

		const results: ReadResult[] = [];
		for (const relative of entries) {
			// Recursive readdir yields directory entries too; only `.md` files parse.
			if (!relative.endsWith('.md')) continue;
			results.push(await readTableFile(entry, directory, subdir, relative));
		}
		return { present: true, results };
	}

	// ── Push (imports markdown files into workspace tables) ─────

	async function pushMarkdownFiles(): Promise<PushResult> {
		const events: PushEvent[] = [];

		for (const entry of registered.values()) {
			const tableName = entry.table.name;
			const { results } = await readTableDir(entry);
			for (const result of results) {
				if (result.kind === 'row') {
					entry.table.set(result.row);
					events.push({
						kind: 'imported',
						path: result.path,
						tableName,
						id: result.id,
					});
				} else if (result.kind === 'skipped') {
					events.push({ kind: 'skipped', path: result.path });
				} else {
					events.push({
						kind: 'error',
						path: result.path,
						tableName,
						error: result.error,
					});
				}
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

	// ── Apply (declarative reconcile: disk is the desired state) ─

	/**
	 * Reconcile the on-disk file set INTO the tables, keyed by row `id`. The
	 * inverse of materialize, and the safe form of "push everything up":
	 *
	 *   creates = ids on disk but not in the table
	 *   updates = ids in both whose row fields differ
	 *   deletes = ids in the table (valid rows) but not on disk
	 *
	 * Guards before any write: a parse/validation error or a duplicate id on ANY
	 * file, or a delete count over `maxDeletes`, refuses the whole run and returns
	 * the plan unapplied (so a stale checkout cannot silently wipe rows). A table
	 * whose directory is MISSING contributes no deletes (a directory that cannot
	 * be read is no signal, not "delete everything"). `dryRun` returns the same
	 * plan without writing. Deletes route through the per-table `onDelete` hook
	 * (default hard delete; pass soft-delete to keep tombstones).
	 *
	 * Single-writer assumption: apply snapshots `getAllValid()` then writes. It
	 * does not guard against a remote sync update landing mid-run, so reconcile
	 * from one place at a time (the daemon, or one device). Yjs still converges;
	 * this is about not racing the plan, not about corruption.
	 *
	 * Boundary: the frontmatter `id` is trusted to target a row, so apply assumes
	 * a single-owner directory; do not point it at untrusted disk. (Reads are
	 * recursive, so nested `filename` layouts round-trip symmetrically.)
	 */
	async function applyMarkdownFiles({
		dryRun = false,
		maxDeletes = DEFAULT_MAX_DELETES,
	}: {
		dryRun?: boolean;
		maxDeletes?: number;
	} = {}): Promise<ApplyPlan> {
		const plan: ApplyPlan = {
			refused: false,
			creates: [],
			updates: [],
			deletes: [],
			skipped: [],
			errors: [],
		};

		// Compute every table's diff first; apply nothing until all guards pass.
		const work: {
			entry: RegisteredTable;
			writes: BaseRow[];
			deletes: string[];
		}[] = [];

		for (const entry of registered.values()) {
			const tableName = entry.table.name;

			// A custom toMarkdown with no inverse cannot be safely reconciled: apply
			// would import only the frontmatter and silently drop whatever else
			// toMarkdown emitted (e.g. a body in a separate doc). Refuse the table.
			if (entry.config.toMarkdown && !entry.config.fromMarkdown) {
				const { error } = MaterializerApplyError.RoundTripUnproven({
					tableName,
				});
				plan.errors.push({
					path: `${entry.config.dir ?? tableName}/`,
					tableName,
					error,
				});
				continue;
			}

			const { present, results } = await readTableDir(entry);
			const desired = new Map<string, { row: BaseRow; path: string }>();
			for (const result of results) {
				if (result.kind === 'skipped') {
					plan.skipped.push({ path: result.path });
				} else if (result.kind === 'error') {
					plan.errors.push({
						path: result.path,
						tableName,
						error: result.error,
					});
				} else {
					const prior = desired.get(result.id);
					if (prior) {
						const { error } = MaterializerApplyError.DuplicateId({
							id: result.id,
							paths: [prior.path, result.path],
						});
						plan.errors.push({ path: result.path, tableName, error });
					} else {
						desired.set(result.id, { row: result.row, path: result.path });
					}
				}
			}

			const current = new Map<string, BaseRow>();
			for (const row of entry.table.getAllValid()) current.set(row.id, row);

			const writes: BaseRow[] = [];
			const deletes: string[] = [];

			for (const [id, { row }] of desired) {
				const existing = current.get(id);
				if (existing === undefined) {
					writes.push(row);
					plan.creates.push({ tableName, id });
				} else if (!Value.Equal(existing, row)) {
					writes.push(row);
					plan.updates.push({ tableName, id });
				}
			}
			// Deletes only when the directory is genuinely present: a row whose
			// file disappeared from an existing directory was removed on purpose;
			// a missing directory tells us nothing about deletions.
			if (present) {
				for (const id of current.keys()) {
					if (!desired.has(id)) {
						deletes.push(id);
						plan.deletes.push({ tableName, id });
					}
				}
			}

			work.push({ entry, writes, deletes });
		}

		// Guards: a broken file must never read as a delete, and a large deletion
		// is refused rather than applied.
		if (plan.errors.length > 0) {
			plan.refused = true;
			plan.reason = `${plan.errors.length} file(s) could not be applied (parse, validation, or duplicate id); refusing to apply.`;
			return plan;
		}
		if (plan.deletes.length > maxDeletes) {
			plan.refused = true;
			plan.reason = `${plan.deletes.length} deletes exceed maxDeletes=${maxDeletes}; refusing to apply. Re-run with a higher limit to confirm.`;
			return plan;
		}
		if (dryRun) return plan;

		// One transaction over every write: peers and observers see the whole
		// reconcile as a single atomic update, never a half-applied intermediate.
		ydoc.transact(() => {
			for (const { entry, writes, deletes } of work) {
				for (const row of writes) entry.table.set(row);
				const onDelete =
					entry.config.onDelete ?? ((id: string) => entry.table.delete(id));
				for (const id of deletes) onDelete(id);
			}
		});

		return plan;
	}

	// ── Rebuild (destructive: wipe output dir and re-materialize) ─

	async function rebuildMarkdownFiles(
		tableName?: string,
	): Promise<{ deleted: number; written: number }> {
		const baseDir = await resolveDir();
		let deleted = 0;
		let written = 0;

		async function rebuildOne(entry: RegisteredTable) {
			const directory = join(baseDir, entry.config.dir ?? entry.table.name);

			// Serialize EVERY row before touching disk. Rebuild is destructive (it
			// sweeps the directory), and `toMarkdown` can throw for a real reason
			// (e.g. fuji's body read hitting its connect deadline). Rendering first
			// means a failed row aborts the rebuild with the existing `.md` files
			// still on disk, rather than deleting everything and then failing to
			// rewrite it.
			const rendered: { filename: string; content: string }[] = [];
			for (const row of entry.table.getAllValid()) {
				rendered.push(await rowToMarkdownFile(row, entry.config));
			}

			// Sweep existing .md files
			try {
				const files = await readdir(directory);
				for (const filename of files) {
					if (!filename.endsWith('.md')) continue;
					const path = join(directory, filename);
					await unlink(path).then(
						() => {
							deleted++;
							markDirty(path);
						},
						() => undefined,
					);
				}
			} catch {
				// Directory doesn't exist yet. Fine.
			}

			await mkdir(directory, { recursive: true });
			for (const { filename, content } of rendered) {
				await writeMarkdownFile(directory, filename, content);
				markDirty(join(directory, filename));
				written++;
			}
		}

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}": not in the materialized table set.`,
				);
			}
			await rebuildOne(entry);
			return { deleted, written };
		}

		for (const entry of registered.values()) await rebuildOne(entry);

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
				markDirty(join(directory, filename));
				written++;
			}
		}
		return { written };
	}

	// ── Public API ───────────────────────────────────────────────

	return {
		whenFlushed,
		actions: defineActions({
			markdown_push: defineMutation({
				title: 'Push Markdown',
				description:
					'Read .md files from disk and import rows into registered tables.',
				handler: pushMarkdownFiles,
			}),
			markdown_pull: defineMutation({
				title: 'Pull Markdown',
				description:
					'Write every valid row from registered tables to .md files on disk.',
				handler: pullMarkdownFiles,
			}),
			markdown_rebuild: defineMutation({
				title: 'Rebuild Markdown',
				description:
					'Destructive: delete existing .md files in registered table directories and re-serialize all valid rows. Optionally limit to one table.',
				input: Type.Object({
					tableName: Type.Optional(
						Type.String({
							description:
								'Limit rebuild to one registered table; omit for all tables.',
						}),
					),
				}),
				handler: ({ tableName }) => rebuildMarkdownFiles(tableName),
			}),
			markdown_apply: defineMutation({
				title: 'Apply Markdown',
				description:
					'Declaratively reconcile .md files into registered tables, keyed by row id: create new files, update changed rows, and delete rows whose file disappeared. Refuses if any file fails to parse/validate or if deletes exceed the limit. Use dryRun to preview the plan.',
				input: Type.Object({
					dryRun: Type.Optional(
						Type.Boolean({
							description: 'Compute and return the plan without writing.',
						}),
					),
					maxDeletes: Type.Optional(
						Type.Number({
							description:
								'Refuse the run if it would delete more rows than this. Default 10.',
						}),
					),
				}),
				handler: ({ dryRun, maxDeletes }) =>
					applyMarkdownFiles({ dryRun, maxDeletes }),
			}),
		}),
	};
}

export type MarkdownMaterializer = ReturnType<
	typeof attachMarkdownMaterializer
>;

function createGitAutosave({
	dir,
	config,
	log,
}: {
	dir: () => Promise<string>;
	config: GitAutosaveConfig;
	log: Logger;
}) {
	const {
		author: { name = 'Autosave', email = 'autosave@epicenter.local' } = {},
		quietMs = 5_000,
		maxBatchMs = 60_000,
	} = config;

	const dirty = new Set<string>();
	let isEnabled: boolean | undefined;
	let enablement: Promise<boolean> | undefined;
	let isDisposed = false;
	let quietTimer: ReturnType<typeof setTimeout> | undefined;
	let maxBatchTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTimers(): void {
		if (quietTimer !== undefined) {
			clearTimeout(quietTimer);
			quietTimer = undefined;
		}
		if (maxBatchTimer !== undefined) {
			clearTimeout(maxBatchTimer);
			maxBatchTimer = undefined;
		}
	}

	async function ensureEnabled(): Promise<boolean> {
		if (isEnabled !== undefined) return isEnabled;
		if (enablement !== undefined) return enablement;
		enablement = (async () => {
			const baseDir = await dir();
			const result = await $`git rev-parse --is-inside-work-tree`
				.cwd(baseDir)
				.nothrow()
				.quiet();
			isEnabled =
				result.exitCode === 0 && result.stdout.toString().trim() === 'true';
			if (!isEnabled) log.info('git autosave: not in a git repo; skipping');
			return isEnabled;
		})().finally(() => {
			enablement = undefined;
		});
		return enablement;
	}

	function schedule(): void {
		if (isDisposed) return;
		if (quietTimer !== undefined) clearTimeout(quietTimer);
		quietTimer = setTimeout(() => {
			quietTimer = undefined;
			void stageAndCommit();
		}, quietMs);
		if (maxBatchTimer === undefined) {
			maxBatchTimer = setTimeout(() => {
				maxBatchTimer = undefined;
				void stageAndCommit();
			}, maxBatchMs);
		}
	}

	async function stageAndCommit(): Promise<void> {
		if (isDisposed) return;
		clearTimers();
		const batch = [...dirty];
		dirty.clear();
		if (batch.length === 0) return;
		if (!(await ensureEnabled())) return;
		await commitBatch(batch, false);
	}

	async function commitBatch(
		batch: readonly string[],
		retried: boolean,
	): Promise<void> {
		const baseDir = await dir();
		const add = await $`git add -- ${batch}`.cwd(baseDir).nothrow().quiet();
		if (add.exitCode !== 0) {
			const stderr = add.stderr.toString();
			if (!retried && stderr.includes('index.lock')) {
				await Bun.sleep(250);
				await commitBatch(batch, true);
				return;
			}
			log.warn(GitAutosaveError.GitAddFailed({ stderr }));
			return;
		}

		const message = `Autosave (${batch.length} changes)`;
		const commit =
			await $`git -c commit.gpgsign=false commit --no-gpg-sign -m ${message} -- ${batch}`
				.cwd(baseDir)
				.env({
					...process.env,
					GIT_AUTHOR_NAME: name,
					GIT_AUTHOR_EMAIL: email,
					GIT_COMMITTER_NAME: name,
					GIT_COMMITTER_EMAIL: email,
				})
				.nothrow()
				.quiet();
		if (commit.exitCode === 0) return;

		const output = `${commit.stdout.toString()}\n${commit.stderr.toString()}`;
		if (
			output.includes('nothing to commit') ||
			output.includes('nothing added to commit')
		) {
			return;
		}
		if (!retried && output.includes('index.lock')) {
			await Bun.sleep(250);
			await commitBatch(batch, true);
			return;
		}
		log.warn(GitAutosaveError.GitCommitFailed({ stderr: output }));
	}

	return {
		async initialize(): Promise<void> {
			await ensureEnabled();
		},
		enqueue(path: string): void {
			if (isDisposed) return;
			void ensureEnabled().then(
				(enabled) => {
					if (!enabled || isDisposed) return;
					dirty.add(path);
					schedule();
				},
				(cause) => log.warn(GitAutosaveError.EnablementCheckFailed({ cause })),
			);
		},
		dispose(): void {
			isDisposed = true;
			clearTimers();
			dirty.clear();
		},
	};
}
