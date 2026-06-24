/**
 * {@link RoomUpdateLog} backed by `bun:sqlite`, one database file per room.
 *
 * The Node/Bun counterpart to `backends/cloudflare/update-log.ts` (which wraps
 * a Durable Object's `ctx.storage.sql`). Same `updates` table, same synchronous
 * contract: the Yjs `updateV2` listener that calls {@link RoomUpdateLog.append}
 * cannot `await`, and `bun:sqlite` is a synchronous engine, so the room logic
 * is identical across backends.
 *
 * `bun:sqlite` reads BLOB columns back as `Uint8Array` (not `Buffer`), which
 * matches what {@link createRoomCore} feeds `Y.applyUpdateV2` with no
 * conversion. The caller owns opening the `Database` and closing it; this only
 * owns the table and the queries against it. WAL mode is enabled here; the
 * caller is responsible for a truncate-checkpoint before close (the macOS
 * persistent-WAL caveat).
 */

import type { Database } from 'bun:sqlite';
import type { RoomUpdateLog } from '../../contracts.js';

/**
 * Build a {@link RoomUpdateLog} over an open `bun:sqlite` database.
 *
 * Idempotent construction (`CREATE TABLE IF NOT EXISTS`) so it is safe on a
 * reopened room file. Statements are prepared once and reused.
 */
export function createBunSqliteUpdateLog(db: Database): RoomUpdateLog {
	db.run('PRAGMA journal_mode = WAL');
	db.run(`
		CREATE TABLE IF NOT EXISTS updates (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			data BLOB NOT NULL
		)
	`);

	const selectAll = db.query<{ data: Uint8Array }, []>(
		'SELECT data FROM updates ORDER BY id',
	);
	const insert = db.query<unknown, [Uint8Array]>(
		'INSERT INTO updates (data) VALUES (?)',
	);
	const deleteAll = db.query('DELETE FROM updates');
	const countRow = db.query<{ count: number }, []>(
		'SELECT COUNT(*) as count FROM updates',
	);
	const pageCount = db.query<{ page_count: number }, []>('PRAGMA page_count');
	const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size');

	// One atomic DELETE + INSERT, the same `transactionSync` guarantee the
	// Cloudflare backend gets from `storage.transactionSync`.
	const replaceAllTx = db.transaction((compacted: Uint8Array) => {
		deleteAll.run();
		insert.run(compacted);
	});

	return {
		loadAll(): Uint8Array[] {
			// Copy each row out of the engine's buffer so the log never aliases
			// sqlite-owned memory once the statement is reused.
			return selectAll.all().map((row) => new Uint8Array(row.data));
		},
		append(update: Uint8Array): void {
			insert.run(update);
		},
		replaceAll(compacted: Uint8Array): void {
			replaceAllTx(compacted);
		},
		byteSize(): number {
			const count = pageCount.get()?.page_count ?? 0;
			const size = pageSize.get()?.page_size ?? 0;
			return count * size;
		},
		entryCount(): number {
			return countRow.get()?.count ?? 0;
		},
	} satisfies RoomUpdateLog;
}
