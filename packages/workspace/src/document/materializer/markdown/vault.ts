import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { tryAsync } from 'wellcrafted/result';
import { assembleMarkdown } from '../../../markdown/assemble-markdown.js';
import { parseMarkdownFile } from '../../../markdown/parse-markdown-file.js';
import { defineActions, defineMutation } from '../../../shared/actions.js';
import type { MaybePromise } from '../../../shared/types.js';
import { type BaseRow, type Table, TableParseError } from '../../table.js';
import type { AnyTable, MaterializerInput, TablesRecord } from '../shared.js';
import {
	type FileState,
	materializeTable,
	type RenderRow,
	rebuildTable,
} from './shared.js';

// ════════════════════════════════════════════════════════════════════════════
// attachMarkdownVault: the editable, two-way markdown seam
//
// A directory of `.md` files a human or coding agent edits, reconciled back into
// Yjs on command. The convention is rigid on purpose, because that rigidity is
// what makes the reconcile safe: every table is a folder, every row is a
// `<id>.md` file, and the frontmatter IS the row. There is no custom filename or
// frontmatter codec; round-trip is identity, so it cannot lose data and needs no
// runtime round-trip guard. For a read-only projection with free serialization
// (slugs, layouts, publish transforms), use `attachMarkdownExport` instead.
// ════════════════════════════════════════════════════════════════════════════

export const MarkdownReadError = defineErrors({
	/** Reading the file from disk failed. */
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MarkdownReadError = InferErrors<typeof MarkdownReadError>;

export const MarkdownApplyError = defineErrors({
	/** Two files on disk declare the same row `id`; the reconcile can't pick one. */
	DuplicateId: ({ id, paths }: { id: string; paths: [string, string] }) => ({
		message: `Two files declare id "${id}": ${paths.join(' and ')}. Remove one before applying.`,
		id,
		paths,
	}),
});
export type MarkdownApplyError = InferErrors<typeof MarkdownApplyError>;

/**
 * A `writeBody` hook threw while importing one entry's body. Logged, never
 * surfaced through `ApplyPlan`: body writes run after the frontmatter transaction
 * commits, so a failure cannot refuse the already-applied run.
 */
const MarkdownBodyImportError = defineErrors({
	BodyWriteFailed: ({
		tableName,
		id,
		cause,
	}: {
		tableName: string;
		id: string;
		cause: unknown;
	}) => ({
		message: `[markdown] body import failed for "${tableName}" (row "${id}"): ${extractErrorMessage(cause)}`,
		tableName,
		id,
		cause,
	}),
});

/**
 * Outcome of reading one `.md` file: a validated row, a non-note (skipped), or a
 * failure. Consumed by `apply`, which diffs the set against the live rows.
 *
 * `path` is relative to the vault `dir` (e.g. `"entries/abc.md"`), not the bare
 * filename: two tables writing the same filename would otherwise be
 * indistinguishable. `error.name` discriminates `ReadFailed` from a table
 * `ValidationFailed` / `MigrationFailed`.
 */
type ReadResult =
	| {
			kind: 'row';
			id: string;
			row: BaseRow;
			path: string;
			/** Parsed body section (undefined when the file has none), for `writeBody`. */
			body: string | undefined;
			/** Raw file content, compared to `fileState` to skip unchanged body writes. */
			rawContent: string;
	  }
	| { kind: 'skipped'; path: string }
	| {
			kind: 'error';
			path: string;
			tableName: string;
			error: MarkdownReadError | TableParseError;
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
	errors: {
		path: string;
		tableName: string;
		error: MarkdownReadError | TableParseError | MarkdownApplyError;
	}[];
};

/**
 * Default ceiling on deletes in one `markdown_apply`. A run that would remove
 * more rows than this refuses and reports the plan instead, so a stale or partial
 * checkout cannot wipe a workspace. Raise per-call via `maxDeletes`.
 */
const DEFAULT_MAX_DELETES = 10;

/**
 * Per-table slot for the vault. Both fields optional: a frontmatter-only table
 * needs neither.
 */
export type VaultTableConfig<TRow extends BaseRow> = {
	/**
	 * Materialize this table's body into the body section of its `.md` file. The
	 * body lives outside the row (e.g. a separate rich-text content doc), so the
	 * vault cannot derive it from the row; supply this to write it to disk. Pairs
	 * with `writeBody` for the import direction. Omit for a frontmatter-only table.
	 */
	readBody?: (row: TRow) => MaybePromise<string>;
	/**
	 * Reconcile an edited body on disk back into its out-of-row home (the inverse
	 * of `readBody`). `apply` calls this for each entry whose `.md` changed since
	 * the vault last materialized it, AFTER the atomic frontmatter transaction: the
	 * body lives in a separate doc and the write is async, so it is per-entry and
	 * best-effort, NOT part of the one-transaction frontmatter reconcile. Omit to
	 * leave bodies read-only (materialize only). A frontmatter-only table needs
	 * neither half.
	 */
	writeBody?: (id: string, markdown: string) => MaybePromise<void>;
	/**
	 * How `markdown_apply` removes a row whose `.md` file disappeared from disk.
	 * Default: hard `table.delete(id)`. Pass a soft-delete (e.g. set `deletedAt`)
	 * for tables that keep tombstones, so the removal still syncs to peers. Must be
	 * synchronous so apply runs every write inside one Yjs transaction.
	 */
	onDelete?: (id: string) => void;
};

/**
 * Mapped per-table config keyed by `workspace.tables` name. Presence is the
 * selection: only tables named here are mirrored into the vault. Keys outside
 * `workspace.tables` are rejected at the type level.
 */
export type VaultTablesConfig<TTableHandles extends TablesRecord> = {
	[K in keyof TTableHandles]?: TTableHandles[K] extends Table<infer TRow>
		? VaultTableConfig<TRow>
		: never;
};

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage, variance across heterogeneous row types
	config: VaultTableConfig<any>;
	fileState: FileState;
	render: RenderRow;
	unsubscribe?: () => void;
};

/**
 * Read one `.md` file into a validated row for `apply`. Parse the frontmatter,
 * strip unknown keys, validate against the latest schema, and carry the parsed
 * body plus the raw content for the body-import path. Never mutates the table.
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
		catch: (cause) => MarkdownReadError.ReadFailed({ cause }),
	});
	if (readError) return { kind: 'error', path, tableName, error: readError };

	const parsed = parseMarkdownFile(content);
	if (!parsed) return { kind: 'skipped', path };

	// Strip any frontmatter key not in the schema BEFORE validating or storing.
	// TypeBox objects allow additional properties, so without this a hand-edited
	// file could smuggle arbitrary keys (including a literal `__proto__`) into the
	// stored row, and unknown keys would also churn every apply as a false diff.
	const latestSchema = entry.table.schema;
	const cleaned = Value.Clean(latestSchema, parsed.frontmatter) as BaseRow;

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

	return {
		kind: 'row',
		id: rowId,
		row: cleaned,
		path,
		body: parsed.body,
		rawContent: content,
	};
}

/**
 * Attach an editable markdown vault to a workspace.
 *
 * Continuously materializes the selected tables into `<dir>/<table>/<id>.md`
 * (frontmatter is the row; an optional `readBody` adds a body section, and a
 * paired `writeBody` makes that body two-way), and exposes two mutations:
 *
 * - `markdown_apply`: reconcile the on-disk `.md` edits back into Yjs, keyed by
 *   id (create/update/delete), guarded by `maxDeletes` and applied in one atomic
 *   transaction; bodies (where `writeBody` is set) are imported per-entry after,
 *   best-effort. The single import path.
 * - `markdown_rebuild`: destructive Yjs → disk re-export (orphan cleanup, config
 *   change). The single explicit export.
 *
 * Teardown is hooked to `workspace.ydoc` via `once('destroy', ...)`; destroying
 * the workspace cascades.
 *
 * @example
 * ```ts
 * const vault = attachMarkdownVault(workspace, {
 *   dir: './vault',
 *   waitFor: idb.whenLoaded,
 *   tables: {
 *     entries: { readBody: (e) => readBody(e), onDelete: (id) => softDelete(id) },
 *     tags: {}, // frontmatter-only
 *   },
 * });
 * ```
 */
export function attachMarkdownVault<TTableHandles extends TablesRecord>(
	workspace: MaterializerInput<TTableHandles>,
	{
		dir,
		tables: tablesConfig,
		waitFor,
		log = createLogger('markdown-vault'),
	}: {
		/** Base output directory. A string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
		/**
		 * Per-table config keyed by `workspace.tables` name. Presence selects: only
		 * tables named here are mirrored. Pass `{}` for a frontmatter-only table.
		 */
		tables?: VaultTablesConfig<TTableHandles>;
		/** Gate: awaited before the initial filesystem flush. Omit for no gate. */
		waitFor?: Promise<unknown>;
		/** Logger for background write-observer failures. */
		log?: Logger;
	},
) {
	const { ydoc, tables } = workspace;
	const registered = new Map<string, RegisteredTable>();
	for (const [name, table] of Object.entries(tables)) {
		const config = (
			tablesConfig as Record<string, VaultTableConfig<BaseRow>> | undefined
		)?.[name];
		if (config === undefined) continue;
		const anyTable = table as AnyTable;
		// Rigid render: `<id>.md`, frontmatter is the row, optional read-only body.
		const render: RenderRow = async (row) =>
			({
				filename: `${row.id}.md`,
				content: assembleMarkdown(
					{ ...row },
					config.readBody ? await config.readBody(row) : undefined,
				),
			}) satisfies { filename: string; content: string };
		registered.set(name, {
			table: anyTable,
			config,
			fileState: new Map(),
			render,
		});
	}
	let isDisposed = false;

	const resolveDir = async () =>
		typeof dir === 'function' ? await dir() : dir;

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		for (const entry of registered.values()) entry.unsubscribe?.();
	}

	ydoc.once('destroy', dispose);

	async function initialize() {
		await waitFor;
		if (isDisposed) return;

		const baseDir = await resolveDir();
		await mkdir(baseDir, { recursive: true });

		for (const entry of registered.values()) {
			if (isDisposed) return;
			entry.unsubscribe = await materializeTable({
				table: entry.table,
				directory: join(baseDir, entry.table.name),
				render: entry.render,
				fileState: entry.fileState,
				log,
				// The vault is editable: never stomp an in-progress edit a future
				// apply will reconcile.
				protectLocalEdits: true,
			});
		}
	}

	const whenFlushed = initialize();

	// Read every `.md` under one table's directory into validated rows. `present`
	// distinguishes a MISSING directory (no desired-state signal) from an EMPTY
	// one (genuinely zero files): apply must not treat "directory gone" as "delete
	// every row". Recursive so a nested layout round-trips with the write side.
	async function readTableDir(
		entry: RegisteredTable,
	): Promise<{ present: boolean; results: ReadResult[] }> {
		const baseDir = await resolveDir();
		const subdir = entry.table.name;
		const directory = join(baseDir, subdir);

		let entries: string[];
		try {
			entries = await readdir(directory, { recursive: true });
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return { present: false, results: [] };
			}
			throw cause;
		}

		const results: ReadResult[] = [];
		for (const relative of entries) {
			if (!relative.endsWith('.md')) continue;
			results.push(await readTableFile(entry, directory, subdir, relative));
		}
		return { present: true, results };
	}

	/**
	 * Reconcile the on-disk file set INTO the tables, keyed by row `id`:
	 *   creates = ids on disk but not in the table
	 *   updates = ids in both whose row fields differ
	 *   deletes = ids in the table (valid rows) but not on disk
	 *
	 * Guards before any write: a parse/validation error or a duplicate id on ANY
	 * file, or a delete count over `maxDeletes`, refuses the whole run and returns
	 * the plan unapplied. A table whose directory is MISSING contributes no
	 * deletes. `dryRun` returns the same plan without writing. Deletes route
	 * through the per-table `onDelete` hook (default hard delete).
	 *
	 * Single-writer assumption: apply snapshots `getAllValid()` then writes inside
	 * one transaction. Reconcile from one place at a time (the daemon).
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
			bodyWrites: { id: string; body: string; rawContent: string }[];
		}[] = [];

		for (const entry of registered.values()) {
			const tableName = entry.table.name;
			const { present, results } = await readTableDir(entry);
			const desired = new Map<
				string,
				{
					row: BaseRow;
					path: string;
					body: string | undefined;
					rawContent: string;
				}
			>();
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
						const { error } = MarkdownApplyError.DuplicateId({
							id: result.id,
							paths: [prior.path, result.path],
						});
						plan.errors.push({ path: result.path, tableName, error });
					} else {
						desired.set(result.id, {
							row: result.row,
							path: result.path,
							body: result.body,
							rawContent: result.rawContent,
						});
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
			if (present) {
				for (const id of current.keys()) {
					if (!desired.has(id)) {
						deletes.push(id);
						plan.deletes.push({ tableName, id });
					}
				}
			}

			// Body imports: only for entries whose `.md` changed since the vault last
			// materialized it (a byte compare against `fileState`, so an untouched
			// file is skipped without opening its body doc; a body-only edit, which
			// the frontmatter diff above cannot see, still qualifies). Skipped
			// entirely when the table has no `writeBody`.
			const bodyWrites: { id: string; body: string; rawContent: string }[] = [];
			if (entry.config.writeBody) {
				for (const [id, { body, rawContent }] of desired) {
					if (rawContent !== entry.fileState.get(id)?.content) {
						bodyWrites.push({ id, body: body ?? '', rawContent });
					}
				}
			}

			work.push({ entry, writes, deletes, bodyWrites });
		}

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

		// Frontmatter is committed atomically above. Import bodies AFTER, outside
		// that transaction: each `writeBody` targets a separate async doc, so it
		// cannot join the root-doc transaction. Best-effort per entry: a failure is
		// logged, never rolled back.
		for (const { entry, bodyWrites } of work) {
			const writeBody = entry.config.writeBody;
			if (!writeBody) continue;
			for (const { id, body, rawContent } of bodyWrites) {
				const { error } = await tryAsync({
					try: async () => writeBody(id, body),
					catch: (cause) =>
						MarkdownBodyImportError.BodyWriteFailed({
							tableName: entry.table.name,
							id,
							cause,
						}),
				});
				if (error) {
					log.warn(error);
					continue;
				}
				// Re-baseline fileState to the content we just imported. A body-only
				// edit never changes the row, so materialize does not re-fire to
				// refresh fileState; without this the next apply would still see the
				// file as changed and re-import the same body every run. Reuse the
				// prior filename (materialize wrote `<id>.md`).
				const previous = entry.fileState.get(id);
				entry.fileState.set(id, {
					filename: previous?.filename ?? `${id}.md`,
					content: rawContent,
				});
			}
		}

		return plan;
	}

	async function rebuildMarkdownFiles(
		tableName?: string,
	): Promise<{ deleted: number; written: number }> {
		const baseDir = await resolveDir();

		async function rebuildOne(entry: RegisteredTable) {
			return rebuildTable({
				table: entry.table,
				directory: join(baseDir, entry.table.name),
				render: entry.render,
				fileState: entry.fileState,
			});
		}

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}": not in the vault's table set.`,
				);
			}
			return rebuildOne(entry);
		}

		let deleted = 0;
		let written = 0;
		for (const entry of registered.values()) {
			const r = await rebuildOne(entry);
			deleted += r.deleted;
			written += r.written;
		}
		return { deleted, written };
	}

	return {
		whenFlushed,
		actions: defineActions({
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

export type MarkdownVault = ReturnType<typeof attachMarkdownVault>;
