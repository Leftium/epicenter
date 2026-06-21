import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ColumnValue, EntityDef } from './entities.ts';

/**
 * The local mirror: one SQLite file per company. Holds an entity table per QB
 * type plus `_sync_state` (the per-entity CDC cursor) and `_meta`. The cursor is
 * written in the same transaction as the rows it accounts for, so ingest and
 * cursor-advance are atomic and crash-safe (see the spec's atomicity argument).
 */

export const SCHEMA_VERSION = '1';

export type SyncStateRow = {
	entity: string;
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/** A live object to upsert; `columns` are in `def.columns` order. */
export type UpsertRow = {
	id: string;
	raw: string;
	updatedAt: string | null;
	columns: ColumnValue[];
};

/** A CDC delete: flip `deleted`, preserve any existing blob. */
export type DeleteRow = {
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

export type BooksDb = ReturnType<typeof openBooksDb>;

export function openBooksDb(path: string, realmId: string) {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	db.exec('PRAGMA journal_mode = WAL;');
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

	setMetaStmt.run('realmId', realmId);
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
		const extra = def.columns
			.map((c) => `${assertIdent(c.name)} ${c.type}`)
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
		const cols = def.columns.map((c) => assertIdent(c.name));
		const insertCols = ['id', 'raw', 'updated_at', 'synced_at', 'deleted', ...cols];
		const placeholders = ['?', '?', '?', '?', '0', ...cols.map(() => '?')];
		const updates = [
			'raw = excluded.raw',
			'updated_at = excluded.updated_at',
			'synced_at = excluded.synced_at',
			'deleted = 0',
			...cols.map((c) => `${c} = excluded.${c}`),
		];
		const stmt = db.query(
			`INSERT INTO ${assertIdent(def.table)} (${insertCols.join(', ')})
			 VALUES (${placeholders.join(', ')})
			 ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`,
		);
		upsertStmts.set(def.table, stmt);
		return stmt;
	}

	function deleteStmtFor(def: EntityDef) {
		const cached = deleteStmts.get(def.table);
		if (cached) return cached;
		// On conflict, only flip the flag + timestamps: keep the existing blob and
		// extracted columns, since a CDC delete payload is just a stub.
		const stmt = db.query(
			`INSERT INTO ${assertIdent(def.table)} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   deleted = 1,
			   synced_at = excluded.synced_at,
			   updated_at = excluded.updated_at`,
		);
		deleteStmts.set(def.table, stmt);
		return stmt;
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
		raw: db,

		ensureEntityTable,

		/**
		 * Apply one entity's sync result atomically: upserts, soft-deletes, and the
		 * advanced `_sync_state` cursor all commit in a single transaction. A crash
		 * mid-write rolls back to the prior cursor, so the next run re-pulls the same
		 * window (idempotent) rather than skipping it.
		 */
		applyEntitySync(
			def: EntityDef,
			{
				upserts,
				deletes,
				syncState,
				syncedAt,
			}: {
				upserts: UpsertRow[];
				deletes: DeleteRow[];
				syncState: SyncStateRow;
				syncedAt: string;
			},
		): void {
			ensureEntityTable(def);
			const upsert = upsertStmtFor(def);
			const markDeleted = deleteStmtFor(def);
			const tx = db.transaction(() => {
				for (const row of upserts) {
					upsert.run(row.id, row.raw, row.updatedAt, syncedAt, ...row.columns);
				}
				for (const row of deletes) {
					markDeleted.run(row.id, row.raw, row.updatedAt, syncedAt);
				}
				writeSyncStateStmt.run(
					syncState.entity,
					syncState.cdcCursor,
					syncState.lastFullPullAt,
					syncState.lastSyncedAt,
				);
			});
			tx();
		},

		readSyncState,

		getMeta(key: string): string | null {
			return getMetaStmt.get(key)?.value ?? null;
		},

		setMeta(key: string, value: string): void {
			setMetaStmt.run(key, value);
		},

		entityStatus(def: EntityDef): EntityStatus {
			const table = assertIdent(def.table);
			const exists = db
				.query<{ n: number }, [string]>(
					`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`,
				)
				.get(def.table);
			const state = readSyncState(def.name);
			if (!exists || exists.n === 0) {
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
			const rows = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get();
			const deleted = db
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table} WHERE deleted = 1`)
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
