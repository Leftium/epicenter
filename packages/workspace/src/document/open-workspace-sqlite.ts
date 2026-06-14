/**
 * Convenience reader for the daemon's SQLite materializer.
 *
 * The daemon's `attachBunSqliteMaterializer` writes a guid-keyed queryable
 * mirror at `sqlitePath(epicenterRoot, workspaceId)`
 * (`.epicenter/sqlite/<workspaceId>.db`). This helper only opens that
 * convention path. A caller that passed a custom `filePath` to the
 * materializer needs `openSqliteReader({ filePath })` with the same explicit
 * path.
 *
 * For ranked FTS5 search plus snippet helpers, use `openSqliteReader`
 * instead; this function intentionally returns a bare `bun:sqlite`
 * `Database` so callers can `db.query(...).all(...)` without extra
 * ceremony.
 */

import type { Database } from 'bun:sqlite';
import type { EpicenterRoot } from '../shared/types.js';
import { openReadonlySqlite } from './open-sqlite-reader.js';
import { sqlitePath } from './workspace-paths.js';

/**
 * Open the daemon's convention-path SQLite mirror for a workspace read-only.
 *
 * The returned handle is read-only and has `query_only` enabled so any
 * accidental write fails at the driver. The caller closes the database with
 * `db.close()` when done.
 *
 * Throws if no file exists at `sqlitePath(epicenterRoot, workspaceId)`. That
 * usually means the daemon has not yet written its first materializer snapshot
 * for this workspace, or the mount wrote SQLite to an override path.
 *
 * @example
 * ```ts
 * import { findEpicenterRoot, openWorkspaceSqlite } from '@epicenter/workspace/node';
 *
 * const db = openWorkspaceSqlite(findEpicenterRoot(), 'epicenter-notes');
 * const welcome = db.query('SELECT * FROM notes WHERE title = ?').all('Welcome');
 * db.close();
 * ```
 *
 * The Fuji mount uses this guid-keyed convention path, so
 * `openWorkspaceSqlite(findEpicenterRoot(), 'epicenter-fuji')` opens its mirror
 * directly.
 */
export function openWorkspaceSqlite(
	epicenterRoot: EpicenterRoot,
	workspaceId: string,
): Database {
	return openReadonlySqlite(sqlitePath(epicenterRoot, workspaceId));
}
