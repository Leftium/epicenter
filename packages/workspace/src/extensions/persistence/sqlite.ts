import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import {
	COMPACTION_BYTE_THRESHOLD,
	COMPACTION_DEBOUNCE_MS,
	compactUpdateLog,
} from '../../document/sqlite-update-log.js';

/**
 * Filesystem persistence factory using SQLite append-log.
 *
 * Stores incremental Y.Doc updates in a SQLite database using the same
 * append-only update log pattern as the Cloudflare Durable Object sync server.
 * Each update is a tiny INSERT (O(update_size)), not a full doc re-encode.
 *
 * **Chain before sync.** This extension does not await prior extensions—it
 * starts loading immediately. The sync extension, when registered after this
 * one, awaits persistence's `init` chain signal before connecting. That way
 * the WebSocket handshake only exchanges the delta between local state and
 * the server, instead of downloading the full document on every cold start.
 *
 * Compaction runs at three points:
 * 1. **Cold start** — replay + compact on initialization
 * 2. **Byte threshold** — when accumulated bytes since last compaction exceed
 *    2 MB, a debounced compaction fires (targets long desktop sessions with
 *    frequent large-value autosaves)
 * 3. **Dispose** — final compact on shutdown
 *
 * **Platform**: Desktop (Tauri, Bun)
 *
 * @example
 * ```typescript
 * import { sqlitePersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
 *
 * // Persistence first, then sync — so sync waits for local state to load.
 * createWorkspace(definition)
 *   .withExtension('persistence', sqlitePersistence({
 *     filePath: join(epicenterDir, 'persistence', `workspace.db`),
 *   }))
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `ws://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 */
export function sqlitePersistence({ filePath }: { filePath: string }) {
	return ({ ydoc }: { ydoc: Y.Doc }) => {
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

		return {
			exports: { whenLoaded },
			init: whenLoaded,
			clearLocalData: () => {
				if (db) {
					db.run('DELETE FROM updates');
				}
			},
			dispose: () => {
				resetCompactionTimer();
				ydoc.off('updateV2', updateHandler);
				if (db) {
					compactUpdateLog(db, ydoc);
					db.close();
				}
			},
		};
	};
}
