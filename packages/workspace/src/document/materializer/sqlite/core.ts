/**
 * SQLite materializer core: the shared body that backend-specific
 * `attach*` factories wrap. Mirrors workspace table rows into a SQLite-shaped
 * mirror via the internal {@link MirrorDatabase} contract.
 *
 * Public callers use the per-backend factories (e.g.
 * `attachBunSqliteMaterializer`), which own the native client lifecycle and
 * adapt it to {@link MirrorDatabase} before calling
 * {@link attachSqliteMaterializerCore} here.
 *
 * Teardown is hooked to the ydoc via `ydoc.once('destroy', ...)`. The
 * per-backend factory registers its own destroy handler too to close the
 * underlying native client.
 *
 * @internal
 * @module
 */

import { debounce } from '@epicenter/util';
import Type from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { defineActions, defineMutation } from '../../../shared/actions.js';
import type { MaybePromise } from '../../../shared/types.js';
import type { BaseRow, Table } from '../../table.js';
import type { AnyTable, TablesRecord } from '../shared.js';
import { generateDdl, quoteIdentifier } from './ddl.js';
import { createSqliteFtsLayer } from './fts.js';

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL SQL EXECUTOR CONTRACT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal SQL executor the materializer body talks to.
 *
 * Structurally compatible with sync drivers (`bun:sqlite`, `better-sqlite3`)
 * and async WASM drivers (`@libsql/client`, `@tursodatabase/database`). The
 * materializer `await`s every call, so sync drivers work without an adapter.
 *
 * Kept internal: each per-backend `attach*` factory (e.g.
 * `attachBunSqliteMaterializer`) owns the adapter from a native client to
 * this contract. Consumers never construct or pass one in.
 *
 * @internal
 */
export type MirrorDatabase = {
	/** Execute raw SQL that does not return rows. */
	run(sql: string): MaybePromise<unknown>;

	/** Prepare a reusable statement for repeated reads or writes. */
	prepare(sql: string): MaybePromise<MirrorStatement>;
};

/**
 * Internal prepared statement interface. Sibling of {@link MirrorDatabase};
 * each backend adapter constructs these from its native client.
 *
 * @internal
 */
export type MirrorStatement = {
	/** Run a statement that writes data or otherwise returns no rows. */
	run(...params: unknown[]): MaybePromise<unknown>;

	/** Fetch all matching rows as plain objects. */
	all(...params: unknown[]): MaybePromise<unknown[]>;

	/** Fetch the first matching row, or null if none found. */
	get(...params: unknown[]): MaybePromise<unknown>;
};

export type { TablesRecord } from '../shared.js';

/**
 * Optional FTS configuration, keyed by the same names as `tables`. Each
 * value lists the columns of that table's row to include in the FTS5 index.
 *
 * The mapped type narrows the value to the row's column names, so typos
 * become compile errors at the call site.
 */
export type FtsConfig<TTables extends TablesRecord> = {
	[K in keyof TTables]?: TTables[K] extends Table<infer TRow>
		? (keyof TRow & string)[]
		: never;
};

/** Errors surfaced by the SQLite materializer's async background sync loop. */
export const SqliteMaterializerError = defineErrors({
	/** Debounced flush of pending row writes to the mirror database failed. */
	SyncFailed: ({ cause }: { cause: unknown }) => ({
		message: `[sqlite-materializer] Failed to sync SQLite materializer: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SqliteMaterializerError = InferErrors<
	typeof SqliteMaterializerError
>;

type RegisteredTable = {
	table: AnyTable;
	unsubscribe?: () => void;
};

/**
 * Internal shared materializer body. Each per-backend factory
 * (`attachBunSqliteMaterializer`, `attachTursoMaterializer`) constructs
 * an adapter from its native client to {@link MirrorDatabase} and forwards
 * into this function.
 *
 * Callers outside this directory should not import this directly.
 *
 * @internal
 */
export function attachSqliteMaterializerCore<
	TTables extends TablesRecord,
	TFts extends FtsConfig<TTables> | undefined = undefined,
>(
	ydoc: Y.Doc,
	{
		db,
		tables,
		fts,
		debounceMs = 100,
		waitFor,
		log = createLogger('sqlite-materializer'),
	}: {
		db: MirrorDatabase;
		/**
		 * Workspace tables to mirror. Each entry becomes a SQLite table named
		 * after the record key.
		 */
		tables: TTables;
		/**
		 * Optional FTS5 configuration. Keyed by the same names as `tables`,
		 * with values listing the columns to include in the FTS index. When
		 * provided, the `actions` registry gains a `sqlite_search` action; when
		 * omitted, only `sqlite_rebuild` is present.
		 */
		fts?: TFts;
		debounceMs?: number;
		/**
		 * Gate: the materializer awaits this before the initial DDL + full-load.
		 * Matches the `waitFor` convention used by `openCollaboration`. Omit
		 * for no gate.
		 */
		waitFor?: Promise<unknown>;
		/**
		 * Logger for background failures (debounced sync flush, FTS query).
		 * Defaults to a console-backed logger with source `sqlite-materializer`.
		 */
		log?: Logger;
	},
) {
	const registered = new Map<string, RegisteredTable>();
	for (const [tableName, table] of Object.entries(tables)) {
		registered.set(tableName, { table: table as AnyTable });
	}

	// FTS lives entirely in its own layer when configured. Core knows nothing
	// about FTS state, columns, or search SQL.
	const ftsLayer =
		fts !== undefined
			? createSqliteFtsLayer<TTables>({ db, fts, log })
			: undefined;

	let pendingSync = new Map<string, Set<string>>();
	let syncQueue = Promise.resolve();
	let isDisposed = false;

	// ── SQL primitives ───────────────────────────────────────────

	async function insertRow(
		tableName: string,
		row: BaseRow & Record<string, unknown>,
	) {
		const keys = Object.keys(row);
		const values = keys.map((key) => serializeValue(row[key]));

		const stmt = await db.prepare(buildUpsertSql(tableName, keys));
		await stmt.run(...values);
	}

	async function deleteRow(tableName: string, id: string) {
		const stmt = await db.prepare(
			`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier('id')} = ?`,
		);
		await stmt.run(id);
	}

	async function fullLoadTable(tableName: string, table: AnyTable) {
		const rows = table.getAllValid();
		if (rows.length === 0) return;

		const keys = collectRowKeys(rows);
		const stmt = await db.prepare(buildUpsertSql(tableName, keys));

		for (const row of rows) {
			const values = keys.map((key) => serializeValue(row[key]));
			await stmt.run(...values);
		}
	}

	// ── Sync engine ──────────────────────────────────────────────

	const flushAfterDebounce = debounce(() => {
		syncQueue = syncQueue.then(flushPendingSync).catch((cause: unknown) => {
			log.error(SqliteMaterializerError.SyncFailed({ cause }));
		});
	}, debounceMs);

	function scheduleSync(tableName: string, changedIds: ReadonlySet<string>) {
		if (isDisposed) return;

		let tableIds = pendingSync.get(tableName);
		if (tableIds === undefined) {
			tableIds = new Set<string>();
			pendingSync.set(tableName, tableIds);
		}

		for (const id of changedIds) tableIds.add(id);

		flushAfterDebounce();
	}

	async function flushPendingSync() {
		if (isDisposed) return;

		const currentPending = pendingSync;
		pendingSync = new Map<string, Set<string>>();

		for (const [tableName, ids] of currentPending) {
			const entry = registered.get(tableName);
			if (entry === undefined) continue;

			for (const id of ids) {
				const { data: row, error } = entry.table.get(id);
				if (error || row === null) {
					// Invalid or missing → drop from mirror.
					await deleteRow(tableName, id);
					continue;
				}
				await insertRow(tableName, row);
			}
		}
	}

	// ── Mutation surface ─────────────────────────────────────────

	async function rebuild(tableName?: string): Promise<void> {
		if (isDisposed) return;

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}": not in the materialized table set.`,
				);
			}
			await db.run('BEGIN');
			try {
				await db.run(`DELETE FROM ${quoteIdentifier(tableName)}`);
				await fullLoadTable(tableName, entry.table);
				await db.run('COMMIT');
			} catch (error: unknown) {
				await db.run('ROLLBACK');
				throw error;
			}
			return;
		}

		await db.run('BEGIN');
		try {
			for (const [name] of registered)
				await db.run(`DELETE FROM ${quoteIdentifier(name)}`);
			for (const [name, entry] of registered)
				await fullLoadTable(name, entry.table);
			await db.run('COMMIT');
		} catch (error: unknown) {
			await db.run('ROLLBACK');
			throw error;
		}
	}

	// ── Disposal ────────────────────────────────────────────────

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		flushAfterDebounce.cancel();
		for (const entry of registered.values()) entry.unsubscribe?.();
	}

	ydoc.once('destroy', dispose);

	// ── Initial flush ────────────────────────────────────────────

	async function initialize() {
		// Always yield a microtask so callers can seed synchronous writes
		// (e.g. `tables.posts.set(...)`) before the full-load reads
		// `getAllValid()`.
		await waitFor;
		if (isDisposed) return;

		for (const [tableName, entry] of registered) {
			await db.run(generateDdl(tableName, entry.table.schema));
		}

		// FTS DDL + triggers run after table DDL and before the bulk insert, so
		// the AFTER INSERT triggers populate `<table>_fts` for free during the
		// existing full-load. This is the load-bearing ordering invariant.
		await ftsLayer?.beforeFullLoad();

		if (isDisposed) return;

		await db.run('BEGIN');
		try {
			for (const [tableName, entry] of registered)
				await fullLoadTable(tableName, entry.table);
			await db.run('COMMIT');
		} catch (error: unknown) {
			await db.run('ROLLBACK');
			throw error;
		}

		if (isDisposed) return;

		for (const [tableName, entry] of registered) {
			entry.unsubscribe = entry.table.observe((changedIds) => {
				scheduleSync(tableName, changedIds);
			});
		}
	}

	const whenFlushed = initialize();

	// Every wire-exposed operation lives in one `actions` registry, mirroring
	// the markdown materializer so a mount spreads `...sqlite.actions`.
	// `sqlite_rebuild` is always present; `sqlite_search` only when an FTS index
	// was configured. Two literal branches keep each registry key required
	// (an optional key would not satisfy the ActionRegistry constraint).
	const rebuildAction = defineMutation({
		title: 'Rebuild SQLite mirror',
		description:
			'Drop and rebuild the materialized SQLite tables from the Yjs source. Optionally limit to one table.',
		input: Type.Object({
			table: Type.Optional(
				Type.String({
					description: 'Limit rebuild to one table; omit for all tables.',
				}),
			),
		}),
		handler: ({ table: tableName }) => rebuild(tableName),
	});

	const actions = ftsLayer
		? defineActions({
				sqlite_rebuild: rebuildAction,
				sqlite_search: ftsLayer.search,
			})
		: defineActions({ sqlite_rebuild: rebuildAction });

	return { whenFlushed, actions };
}

// ════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build an UPSERT statement: insert with `ON CONFLICT(id) DO UPDATE`.
 *
 * Avoids `INSERT OR REPLACE` because Turso's Rust engine doesn't support
 * that form yet (parses as "INSERT OR REPLACE is only supported with
 * UPSERT"). Standard UPSERT works across bun:sqlite, libSQL, and Turso.
 *
 * When `keys.length === 1` (just `id`), there's nothing to update on
 * conflict, so the statement collapses to `INSERT ... ON CONFLICT DO NOTHING`
 * (SET clauses with zero assignments are a SQL error).
 */
function buildUpsertSql(tableName: string, keys: string[]): string {
	const quotedTable = quoteIdentifier(tableName);
	const columns = keys.map(quoteIdentifier).join(', ');
	const placeholders = keys.map(() => '?').join(', ');
	const updateKeys = keys.filter((key) => key !== 'id');

	if (updateKeys.length === 0) {
		return `INSERT INTO ${quotedTable} (${columns}) VALUES (${placeholders}) ON CONFLICT(${quoteIdentifier('id')}) DO NOTHING`;
	}

	const setClause = updateKeys
		.map((key) => `${quoteIdentifier(key)} = excluded.${quoteIdentifier(key)}`)
		.join(', ');

	return `INSERT INTO ${quotedTable} (${columns}) VALUES (${placeholders}) ON CONFLICT(${quoteIdentifier('id')}) DO UPDATE SET ${setClause}`;
}

function collectRowKeys(rows: readonly BaseRow[]): string[] {
	const keys = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) keys.add(key);
	}
	return [...keys];
}

/**
 * Convert a workspace row value into a SQLite-compatible value.
 *
 * - `null` / `undefined` → SQL `NULL`
 * - `object` / `array` → JSON string (`TEXT` column)
 * - `boolean` → `0` or `1` (`INTEGER` column)
 * - everything else → passed through as-is
 */
function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === 'object') return JSON.stringify(value);
	if (typeof value === 'boolean') return value ? 1 : 0;
	return value;
}
