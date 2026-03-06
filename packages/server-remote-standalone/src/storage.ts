import { Database } from 'bun:sqlite';
import type { UpdateLog } from '@epicenter/sync-core';

/**
 * UpdateLog implementation backed by bun:sqlite.
 *
 * Same schema as createDoSqliteUpdateLog but uses Bun's SQLite driver.
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

	append(docId: string, update: Uint8Array): void {
		this.stmtAppend.run({ $docId: docId, $data: update });
	}

	readAll(docId: string): Uint8Array[] {
		const rows = this.stmtReadAll.all({ $docId: docId }) as Array<{
			data: Buffer;
		}>;
		return rows.map((row) => new Uint8Array(row.data));
	}

	replaceAll(docId: string, mergedUpdate: Uint8Array): void {
		this.db.transaction(() => {
			this.stmtDelete.run({ $docId: docId });
			this.stmtAppend.run({ $docId: docId, $data: mergedUpdate });
		})();
	}

	close(): void {
		this.db.close();
	}
}
