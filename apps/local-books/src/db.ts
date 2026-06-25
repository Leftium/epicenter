import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	type EntityDef,
	isDeleted,
	lastUpdatedTime,
	type QbObject,
} from './entities.ts';

/**
 * The local mirror: one SQLite file per company. Holds an entity table per QB
 * type plus `_sync_state` (the per-entity CDC cursor) and `_meta`. The cursor is
 * written in the same transaction as the rows it accounts for, so ingest and
 * cursor-advance are atomic and crash-safe (see the spec's atomicity argument).
 *
 * The realm owns its identity through the path (`<dataDir>/<realmId>/books.db`),
 * not a stored column, so the db need not know which company it holds.
 */

export const SCHEMA_VERSION = '1';

export type SyncStateRow = {
	entity: string;
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/**
 * One row destined for an entity table, keyed by QB `id`: the blob plus the
 * timestamp the mirror orders writes by. Built inside `ingest` from a QB object;
 * the destiny (upsert vs soft-delete) is the array it lands in, not the type. The
 * extracted columns are generated from `raw`, so no row carries them.
 */
type MirrorRow = {
	id: string;
	raw: string;
	updatedAt: string | null;
};

export type EntityStatus = {
	entity: string;
	table: string;
	rows: number;
	deleted: number;
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
function assertIdent(name: string): string {
	if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
	return name;
}

// Generated-column paths are inlined into the CREATE TABLE string literal, so
// each QB field segment must be a bare identifier (no quotes, dots, or `$`).
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function jsonExtractPath(segments: string[]): string {
	for (const seg of segments) {
		if (!PATH_SEGMENT.test(seg)) {
			throw new Error(`Unsafe JSON path segment: ${seg}`);
		}
	}
	return `$.${segments.join('.')}`;
}

export type BooksDb = ReturnType<typeof openBooksDb>;

export function openBooksDb(path: string) {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	// The mirror's concurrency contract, set once for every connection. The
	// daemon's recategorize write-back and `local-books sync` are separate
	// processes on one file, so: WAL (readers never block the writer), a
	// busy_timeout (a writer waits for a concurrent writer's lock instead of
	// failing instantly with SQLITE_BUSY), and synchronous=NORMAL (the mirror is a
	// re-pullable cache, so a lost last-commit on power loss just re-pulls; it
	// cannot corrupt the ledger, which QuickBooks owns).
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA busy_timeout = 5000;');
	db.exec('PRAGMA synchronous = NORMAL;');
	db.exec('PRAGMA foreign_keys = ON;');

	db.exec(`
		CREATE TABLE IF NOT EXISTS _sync_state (
			entity            TEXT PRIMARY KEY,
			cdc_cursor        TEXT,
			last_full_pull_at TEXT,
			last_synced_at    TEXT
		);
		CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
	`);

	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	setMetaStmt.run('schema_version', SCHEMA_VERSION);

	// Prepared-statement caches, keyed by table.
	const upsertStmts = new Map<string, ReturnType<typeof db.query>>();
	const deleteStmts = new Map<string, ReturnType<typeof db.query>>();

	const writeSyncStateStmt = db.query(
		`INSERT INTO _sync_state (entity, cdc_cursor, last_full_pull_at, last_synced_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(entity) DO UPDATE SET
		   cdc_cursor = excluded.cdc_cursor,
		   last_full_pull_at = excluded.last_full_pull_at,
		   last_synced_at = excluded.last_synced_at`,
	);

	function ensureEntityTable(def: EntityDef): void {
		const table = assertIdent(def.table);
		// Each extracted column is a VIRTUAL generated projection of `raw`, so the
		// blob stays the single source of truth: no write-path extraction, and a
		// missing field is `json_extract`'s null for free.
		const extra = def.columns
			.map(
				(c) =>
					`${assertIdent(c.name)} ${c.type} GENERATED ALWAYS AS (json_extract(raw, '${jsonExtractPath(c.path)}')) VIRTUAL`,
			)
			.join(',\n\t\t\t\t');
		db.exec(`
			CREATE TABLE IF NOT EXISTS ${table} (
				id          TEXT PRIMARY KEY,
				raw         TEXT NOT NULL,
				updated_at  TEXT,
				synced_at   TEXT NOT NULL,
				deleted     INTEGER NOT NULL DEFAULT 0${extra ? ',\n\t\t\t\t' + extra : ''}
			);
			CREATE INDEX IF NOT EXISTS idx_${table}_updated_at ON ${table}(updated_at);
		`);
	}

	function upsertStmtFor(def: EntityDef) {
		const cached = upsertStmts.get(def.table);
		if (cached) return cached;
		const table = assertIdent(def.table);
		// Monotonic upsert: a row only ever moves forward. The DO UPDATE applies only
		// when the incoming object is at least as new as the stored one (by QB
		// LastUpdatedTime), so a stale write cannot regress the mirror, e.g.
		// recategorize folding its own response back after a concurrent sync already
		// ingested a newer bookkeeper edit. A missing timestamp on either side falls
		// back to last-writer-wins (nothing to order on). The extracted columns are
		// generated from `raw`, so the upsert writes only the blob and its bookkeeping.
		const stmt = db.query(
			`INSERT INTO ${table} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 0)
			 ON CONFLICT(id) DO UPDATE SET
			   raw = excluded.raw,
			   updated_at = excluded.updated_at,
			   synced_at = excluded.synced_at,
			   deleted = 0
			 WHERE excluded.updated_at IS NULL
			    OR ${table}.updated_at IS NULL
			    OR excluded.updated_at >= ${table}.updated_at`,
		);
		upsertStmts.set(def.table, stmt);
		return stmt;
	}

	function deleteStmtFor(def: EntityDef) {
		const cached = deleteStmts.get(def.table);
		if (cached) return cached;
		const table = assertIdent(def.table);
		// On conflict, only flip the flag + timestamps and keep the existing blob (a
		// CDC delete payload is just a stub); the generated columns keep projecting
		// that preserved blob, so the last-known scalars survive. Same monotonic guard
		// as the upsert: a stale delete cannot override a newer live update.
		const stmt = db.query(
			`INSERT INTO ${table} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   deleted = 1,
			   synced_at = excluded.synced_at,
			   updated_at = excluded.updated_at
			 WHERE excluded.updated_at IS NULL
			    OR ${table}.updated_at IS NULL
			    OR excluded.updated_at >= ${table}.updated_at`,
		);
		deleteStmts.set(def.table, stmt);
		return stmt;
	}

	function tableExists(name: string): boolean {
		const row = db
			.query<{ n: number }, [string]>(
				`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`,
			)
			.get(name);
		return (row?.n ?? 0) > 0;
	}

	function readSyncState(entity: string): SyncStateRow | null {
		const row = db
			.query<
				{
					entity: string;
					cdc_cursor: string | null;
					last_full_pull_at: string | null;
					last_synced_at: string | null;
				},
				[string]
			>(`SELECT * FROM _sync_state WHERE entity = ?`)
			.get(entity);
		if (!row) return null;
		return {
			entity: row.entity,
			cdcCursor: row.cdc_cursor,
			lastFullPullAt: row.last_full_pull_at,
			lastSyncedAt: row.last_synced_at,
		};
	}

	return {
		/** Escape hatch for ad-hoc queries (tests, diagnostics). */
		raw: db,

		/**
		 * The mirror's one write door: fold a batch of QB objects into the entity
		 * table. Both writers come through here, `local-books sync` (with a `cursor`
		 * to advance) and the recategorize write-back (without one), so "a QB object
		 * becomes mirror rows" lives in exactly one place. Live objects upsert,
		 * `status: "Deleted"` objects soft-delete, both monotonically (a stale write
		 * never regresses a row). When `cursor` is given, the advanced `_sync_state`
		 * commits in the SAME transaction as the rows it accounts for, so
		 * ingest-and-advance is atomic and crash-safe: a crash mid-write rolls back to
		 * the prior cursor and the next run re-pulls the same window (idempotent). The
		 * transaction is IMMEDIATE so the write lock is taken up front and a concurrent
		 * writer waits (busy_timeout) rather than racing into a mid-transaction lock
		 * failure. Returns the partition counts.
		 */
		ingest(
			def: EntityDef,
			{
				objects,
				syncedAt,
				cursor,
			}: {
				objects: QbObject[];
				syncedAt: string;
				cursor?: SyncStateRow;
			},
		): { upserted: number; deleted: number } {
			ensureEntityTable(def);
			const upsert = upsertStmtFor(def);
			const markDeleted = deleteStmtFor(def);

			const upserts: MirrorRow[] = [];
			const deletes: MirrorRow[] = [];
			for (const obj of objects) {
				const id = obj.Id != null ? String(obj.Id) : null;
				if (!id) continue; // skip malformed objects with no Id
				const row: MirrorRow = {
					id,
					raw: JSON.stringify(obj),
					updatedAt: lastUpdatedTime(obj),
				};
				(isDeleted(obj) ? deletes : upserts).push(row);
			}

			const tx = db.transaction(() => {
				for (const row of upserts) {
					upsert.run(row.id, row.raw, row.updatedAt, syncedAt);
				}
				for (const row of deletes) {
					markDeleted.run(row.id, row.raw, row.updatedAt, syncedAt);
				}
				if (cursor) {
					writeSyncStateStmt.run(
						cursor.entity,
						cursor.cdcCursor,
						cursor.lastFullPullAt,
						cursor.lastSyncedAt,
					);
				}
			});
			tx.immediate();

			return { upserted: upserts.length, deleted: deletes.length };
		},

		/**
		 * Read one live row's verbatim QB blob by id, or `null` if the entity table
		 * does not exist yet, the row is unknown, or it is soft-deleted. The read
		 * counterpart to `ingest`: callers reach a mirror row without hand-writing SQL
		 * against a table name. (`books_sql_query` keeps its own read-only connection
		 * for arbitrary queries; this serves the write-capable handle the write-back
		 * already holds.)
		 */
		getLiveRaw(def: EntityDef, id: string): string | null {
			if (!tableExists(def.table)) return null;
			const row = db
				.query<{ raw: string }, [string]>(
					`SELECT raw FROM ${assertIdent(def.table)} WHERE id = ? AND deleted = 0`,
				)
				.get(id);
			return row?.raw ?? null;
		},

		readSyncState,

		getMeta(key: string): string | null {
			return getMetaStmt.get(key)?.value ?? null;
		},

		entityStatus(def: EntityDef): EntityStatus {
			const table = assertIdent(def.table);
			const state = readSyncState(def.name);
			if (!tableExists(def.table)) {
				return {
					entity: def.name,
					table: def.table,
					rows: 0,
					deleted: 0,
					cdcCursor: state?.cdcCursor ?? null,
					lastFullPullAt: state?.lastFullPullAt ?? null,
					lastSyncedAt: state?.lastSyncedAt ?? null,
				};
			}
			const rows = db
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
				.get();
			const deleted = db
				.query<{ n: number }, []>(
					`SELECT count(*) AS n FROM ${table} WHERE deleted = 1`,
				)
				.get();
			return {
				entity: def.name,
				table: def.table,
				rows: rows?.n ?? 0,
				deleted: deleted?.n ?? 0,
				cdcCursor: state?.cdcCursor ?? null,
				lastFullPullAt: state?.lastFullPullAt ?? null,
				lastSyncedAt: state?.lastSyncedAt ?? null,
			};
		},

		close(): void {
			db.close();
		},
	};
}
