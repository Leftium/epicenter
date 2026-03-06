import type { UpdateLog } from '@epicenter/sync-core';

/**
 * Create an UpdateLog backed by Durable Object SQLite.
 *
 * Uses the DO's built-in SQLite database for persistent Y.Doc update storage.
 * SQLite in Durable Objects is GA with 10GB per DO.
 */
export function createDoSqliteUpdateLog(
	storage: DurableObjectStorage,
): UpdateLog {
	let initialized = false;

	function ensureTable() {
		if (initialized) return;
		storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS updates (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				doc_id TEXT NOT NULL,
				data BLOB NOT NULL,
				created_at INTEGER DEFAULT (unixepoch())
			)
		`);
		initialized = true;
	}

	return {
		append(docId, update) {
			ensureTable();
			storage.sql.exec(
				'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
				docId,
				update,
			);
		},

		readAll(docId) {
			ensureTable();
			const cursor = storage.sql.exec(
				'SELECT data FROM updates WHERE doc_id = ? ORDER BY id',
				docId,
			);
			return [...cursor].map(
				(row) => new Uint8Array(row.data as ArrayBuffer),
			);
		},

		replaceAll(docId, mergedUpdate) {
			ensureTable();
			storage.transactionSync(() => {
				storage.sql.exec('DELETE FROM updates WHERE doc_id = ?', docId);
				storage.sql.exec(
					'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
					docId,
					mergedUpdate,
				);
			});
		},
	};
}
