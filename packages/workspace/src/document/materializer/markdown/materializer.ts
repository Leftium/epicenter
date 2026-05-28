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
		cause,
	}: {
		tableName: string;
		cause: unknown;
	}) => ({
		message: `[markdown-materializer] table write failed for "${tableName}": ${extractErrorMessage(cause)}`,
		tableName,
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

type MaterializerWriteEvent = {
	kind: 'wrote' | 'unlinked';
	path: string;
	tableName: string;
};

/** Aggregated result of one `push` invocation. */
export type PushResult = {
	imported: number;
	skipped: number;
	errored: number;
	events: PushEvent[];
};

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
	/** Parse frontmatter + body back into a row. Default: `parsed.frontmatter as TRow`. */
	fromMarkdown?: (parsed: MarkdownShape) => MaybePromise<TRow>;
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
	const emitWrite = (event: MaterializerWriteEvent): void => {
		gitAutosave?.enqueue(event.path);
	};

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
			emitWrite({
				kind: 'wrote',
				path: join(directory, filename),
				tableName: table.name,
			});
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
							if (removed) {
								emitWrite({
									kind: 'unlinked',
									path: join(directory, previous),
									tableName: table.name,
								});
							}
						}
						continue;
					}

					const { filename, content } = await rowToMarkdownFile(row, config);
					const previous = filenames.get(id);
					if (previous && previous !== filename) {
						const removed = await tryUnlink(directory, previous);
						if (removed) {
							emitWrite({
								kind: 'unlinked',
								path: join(directory, previous),
								tableName: table.name,
							});
						}
					}
					await writeMarkdownFile(directory, filename, content);
					filenames.set(id, filename);
					emitWrite({
						kind: 'wrote',
						path: join(directory, filename),
						tableName: table.name,
					});
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

		async function rebuildOne(entry: RegisteredTable) {
			const directory = join(baseDir, entry.config.dir ?? entry.table.name);

			// Sweep existing .md files
			try {
				const files = await readdir(directory);
				for (const filename of files) {
					if (!filename.endsWith('.md')) continue;
					const path = join(directory, filename);
					await unlink(path).then(
						() => {
							deleted++;
							emitWrite({
								kind: 'unlinked',
								path,
								tableName: entry.table.name,
							});
						},
						() => undefined,
					);
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
				emitWrite({
					kind: 'wrote',
					path: join(directory, filename),
					tableName: entry.table.name,
				});
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
				emitWrite({
					kind: 'wrote',
					path: join(directory, filename),
					tableName: entry.table.name,
				});
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
