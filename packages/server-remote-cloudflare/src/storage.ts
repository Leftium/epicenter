import type { UpdateLog } from '@epicenter/sync-core';
import * as Y from 'yjs';

/**
 * UpdateLog implementation backed by Durable Object SQLite.
 *
 * Uses the DO's built-in SQLite database for persistent Y.Doc update storage.
 * SQLite in Durable Objects is GA with 10GB per DO.
 */
export class DOSqliteUpdateLog implements UpdateLog {
	private initialized = false;

	constructor(private storage: DurableObjectStorage) {}

	private ensureTable(): void {
		if (this.initialized) return;
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS updates (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				doc_id TEXT NOT NULL,
				data BLOB NOT NULL,
				created_at INTEGER DEFAULT (unixepoch())
			)
		`);
		this.initialized = true;
	}

	async append(docId: string, update: Uint8Array): Promise<void> {
		this.ensureTable();
		this.storage.sql.exec(
			'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
			docId,
			update,
		);
	}

	async readAll(docId: string): Promise<Uint8Array[]> {
		this.ensureTable();
		const cursor = this.storage.sql.exec(
			'SELECT data FROM updates WHERE doc_id = ? ORDER BY id',
			docId,
		);
		return [...cursor].map((row) => new Uint8Array(row.data as ArrayBuffer));
	}

	async replaceAll(docId: string, mergedUpdate: Uint8Array): Promise<void> {
		this.ensureTable();
		this.storage.transactionSync(() => {
			this.storage.sql.exec('DELETE FROM updates WHERE doc_id = ?', docId);
			this.storage.sql.exec(
				'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
				docId,
				mergedUpdate,
			);
		});
	}

	/** Compact all updates for a doc — called on last disconnect before hibernation. */
	async compactAll(docId: string): Promise<void> {
		const updates = await this.readAll(docId);
		if (updates.length <= 1) return;

		const merged = Y.mergeUpdatesV2(updates);
		await this.replaceAll(docId, merged);
	}
}
