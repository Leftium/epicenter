import { Database } from 'bun:sqlite';
import type { UpdateLog } from '@epicenter/sync-core';
import * as Y from 'yjs';

/**
 * UpdateLog implementation backed by bun:sqlite.
 *
 * Same schema as DOSqliteUpdateLog but uses Bun's SQLite driver.
 * The database file lives on disk so data survives process restarts.
 */
export class BunSqliteUpdateLog implements UpdateLog {
	private db: Database;
	private stmtAppend: ReturnType<Database['prepare']>;
	private stmtReadAll: ReturnType<Database['prepare']>;
	private stmtDelete: ReturnType<Database['prepare']>;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.exec('PRAGMA journal_mode = WAL');
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS updates (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				doc_id TEXT NOT NULL,
				data BLOB NOT NULL,
				created_at INTEGER DEFAULT (unixepoch())
			)
		`);

		this.stmtAppend = this.db.prepare(
			'INSERT INTO updates (doc_id, data) VALUES ($docId, $data)',
		);
		this.stmtReadAll = this.db.prepare(
			'SELECT data FROM updates WHERE doc_id = $docId ORDER BY id',
		);
		this.stmtDelete = this.db.prepare(
			'DELETE FROM updates WHERE doc_id = $docId',
		);
	}

	async append(docId: string, update: Uint8Array): Promise<void> {
		this.stmtAppend.run({ $docId: docId, $data: update });
	}

	async readAll(docId: string): Promise<Uint8Array[]> {
		const rows = this.stmtReadAll.all({ $docId: docId }) as Array<{
			data: Buffer;
		}>;
		return rows.map((row) => new Uint8Array(row.data));
	}

	async replaceAll(docId: string, mergedUpdate: Uint8Array): Promise<void> {
		this.db.transaction(() => {
			this.stmtDelete.run({ $docId: docId });
			this.stmtAppend.run({ $docId: docId, $data: mergedUpdate });
		})();
	}

	/** Compact all updates for a doc into a single merged blob. */
	async compactAll(docId: string): Promise<void> {
		const updates = await this.readAll(docId);
		if (updates.length <= 1) return;

		const merged = Y.mergeUpdatesV2(updates);
		await this.replaceAll(docId, merged);
	}

	close(): void {
		this.db.close();
	}
}
