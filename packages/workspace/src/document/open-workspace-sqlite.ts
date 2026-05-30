/**
 * Convenience reader for the daemon's SQLite materializer.
 *
 * The daemon's `attachBunSqliteMaterializer` writes a queryable mirror at
 * `sqlitePath(projectDir, workspaceId)`. Scripts open that same file read-only
 * to issue plain SQL, bypassing the Y.Doc replay cost.
 *
 * For ranked FTS5 search plus snippet helpers, use `openSqliteReader`
 * instead; this function intentionally returns a bare `bun:sqlite`
 * `Database` so callers can `db.query(...).all(...)` (or wrap it with
 * Drizzle) without extra ceremony.
 */

import type { Database } from 'bun:sqlite';
import type { ProjectDir } from '../shared/types.js';
import { openReadonlySqlite } from './open-sqlite-reader.js';
import { sqlitePath } from './workspace-paths.js';

/**
 * Open the daemon's SQLite mirror for a workspace read-only.
 *
 * The returned handle is read-only and has `query_only` enabled so any
 * accidental write fails at the driver. The caller closes the database with
 * `db.close()` when done.
 *
 * Throws if no file exists at `sqlitePath(projectDir, workspaceId)`. That
 * usually means the daemon has not yet written its first materializer
 * snapshot for this workspace.
 *
 * @example
 * ```ts
 * import { findProjectRoot, openWorkspaceSqlite } from '@epicenter/workspace/node';
 * import { FUJI_ID } from '@epicenter/fuji';
 *
 * const db = openWorkspaceSqlite(findProjectRoot(), FUJI_ID);
 * const welcome = db.query('SELECT * FROM entries WHERE title = ?').all('Welcome to Fuji');
 * db.close();
 * ```
 */
export function openWorkspaceSqlite(
	projectDir: ProjectDir,
	workspaceId: string,
): Database {
	return openReadonlySqlite(sqlitePath(projectDir, workspaceId));
}
