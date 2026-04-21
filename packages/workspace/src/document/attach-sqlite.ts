import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import {
	COMPACTION_BYTE_THRESHOLD,
	COMPACTION_DEBOUNCE_MS,
	compactUpdateLog,
} from './sqlite-update-log.js';

export type SqliteAttachment = {
	/**
	 * Resolves when local SQLite state has replayed into the Y.Doc — "your
	 * draft is in memory, edits are safe." Not CRDT convergence. Pair with
	 * `sync.whenConnected` when you also need remote state.
	 */
	whenLoaded: Promise<void>;
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after the Y.Doc is destroyed AND final compaction + DB close
	 * complete. Opt-in — tests and CLIs flushing before exit await this.
	 * Named symmetrically with `whenLoaded` — both are promises.
	 */
	whenDisposed: Promise<void>;
};

export function attachSqlite(
	ydoc: Y.Doc,
	{ filePath }: { filePath: string },
): SqliteAttachment {
	let db: Database | null = null;
	let bytesSinceCompaction = 0;
	let compactionTimer: ReturnType<typeof setTimeout> | null = null;

	function resetCompactionTimer() {
		if (compactionTimer) {
			clearTimeout(compactionTimer);
			compactionTimer = null;
		}
	}

	const updateHandler = (update: Uint8Array) => {
		db?.run('INSERT INTO updates (data) VALUES (?)', [update]);

		bytesSinceCompaction += update.byteLength;
		if (bytesSinceCompaction > COMPACTION_BYTE_THRESHOLD) {
			resetCompactionTimer();
			compactionTimer = setTimeout(() => {
				if (db && compactUpdateLog(db, ydoc)) {
					bytesSinceCompaction = 0;
				}
			}, COMPACTION_DEBOUNCE_MS);
		}
	};

	const whenLoaded = (async () => {
		await mkdir(path.dirname(filePath), { recursive: true });

		db = new Database(filePath);
		db.run(
			'CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)',
		);

		const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
			data: Buffer;
		}[];
		for (const row of rows) {
			Y.applyUpdateV2(ydoc, new Uint8Array(row.data));
		}

		compactUpdateLog(db, ydoc);
		ydoc.on('updateV2', updateHandler);
	})();

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	ydoc.once('destroy', () => {
		try {
			resetCompactionTimer();
			ydoc.off('updateV2', updateHandler);
			if (db) {
				compactUpdateLog(db, ydoc);
				db.close();
				db = null;
			}
		} finally {
			resolveDisposed();
		}
	});

	return {
		whenLoaded,
		clearLocal: () =>
			Promise.resolve().then(() => {
				db?.run('DELETE FROM updates');
			}),
		whenDisposed,
	};
}
