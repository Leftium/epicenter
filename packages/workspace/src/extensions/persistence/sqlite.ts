import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';

/** Max compacted update size (2 MB). Matches the Cloudflare DO limit. */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Compact the SQLite update log into a single row.
 *
 * Encodes the current doc state via `Y.encodeStateAsUpdateV2` — produces
 * smaller output than merging individual updates. No-ops if the log already
 * has ≤ 1 row or the compacted blob exceeds 2 MB.
 */
function compactUpdateLog(db: Database, ydoc: Y.Doc): void {
	const row = db.query('SELECT COUNT(*) as count FROM updates').get() as {
		count: number;
	};
	if (row.count <= 1) return;

	const compacted = Y.encodeStateAsUpdateV2(ydoc);
	if (compacted.byteLength > MAX_COMPACTED_BYTES) return;

	db.transaction(() => {
		db.run('DELETE FROM updates');
		db.run('INSERT INTO updates (data) VALUES (?)', [compacted]);
	})();
}

/**
 * Initialize a SQLite persistence database: create table, replay updates, compact.
 *
 * Shared setup logic used by `filesystemPersistence`.
 */
function initPersistenceDb(filePath: string, ydoc: Y.Doc): Database {
	const db = new Database(filePath);
	db.run(
		'CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)',
	);

	// Replay update log to reconstruct Y.Doc state
	const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
		data: Buffer;
	}[];
	for (const row of rows) {
		Y.applyUpdateV2(ydoc, new Uint8Array(row.data));
	}

	// Compact on startup if the log has accumulated many rows
	compactUpdateLog(db, ydoc);

	return db;
}

/**
 * Filesystem persistence factory using SQLite append-log.
 *
 * Stores incremental Y.Doc updates in a SQLite database using the same
 * append-only update log pattern as the Cloudflare Durable Object sync server.
 * Each update is a tiny INSERT (O(update_size)), not a full doc re-encode.
 *
 * **Platform**: Desktop (Tauri, Bun)
 *
 * @example
 * ```typescript
 * import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', filesystemPersistence({
 *     filePath: join(epicenterDir, 'persistence', `workspace.db`),
 *   }))
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `ws://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 */
export function filesystemPersistence({ filePath }: { filePath: string }) {
	return ({ ydoc }: { ydoc: Y.Doc }) => {
		let db: Database | null = null;

		const updateHandler = (update: Uint8Array) => {
			db?.run('INSERT INTO updates (data) VALUES (?)', [update]);
		};

		const whenReady = (async () => {
			await mkdir(path.dirname(filePath), { recursive: true });
			db = initPersistenceDb(filePath, ydoc);
			ydoc.on('updateV2', updateHandler);
		})();

		return {
			whenReady,
			dispose: () => {
				ydoc.off('updateV2', updateHandler);
				if (db) {
					compactUpdateLog(db, ydoc);
					db.close();
				}
			},
		};
	};
}
