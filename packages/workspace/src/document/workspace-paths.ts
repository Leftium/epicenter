/**
 * Per-workspace data layout helpers.
 *
 * `epicenterRoot` is the Epicenter root: the app folder that holds
 * `epicenter.config.ts`. It is NOT necessarily the repo root.
 *
 * Hidden machine state under `<epicenterRoot>/.epicenter/`, each folder named by
 * what's inside:
 *
 *   yjs/<id>.db     Yjs CRDT update log (durability; replayed by Yjs)
 *   sqlite/<id>.db  Queryable SQL surface (open with `sqlite3`, FTS5)
 *   md/<id>/        Legacy hidden markdown tree (playground daemons only)
 *
 * These helpers return the hardcoded convention only; they do not inspect
 * `epicenter.config.ts`.
 *
 * For daemon-process paths (sockets, log, metadata sidecar), see
 * `daemon/paths.ts`. Different audience, different rationale.
 *
 * Pure helpers: no side effects, no directory creation. Consumers do their
 * own `mkdir` (or rely on the attachments to do it).
 */

import { join } from 'node:path';

function epicenterStateDir(epicenterRoot: string): string {
	return join(epicenterRoot, '.epicenter');
}

/**
 * Path to a workspace's Yjs CRDT update log.
 *
 * Convention: `<epicenterRoot>/.epicenter/yjs/<workspaceId>.db`. This file is the
 * source of truth: every `updateV2` event lands here as a row, and the
 * file is replayed at startup to reconstruct the Y.Doc. SQLite is the
 * implementation detail; you never query this file with `sqlite3`. For
 * the queryable surface, see `sqlitePath`.
 *
 * `epicenterRoot` is the Epicenter root (the folder that holds
 * `epicenter.config.ts`); `workspaceId` is `ws.ydoc.guid`.
 *
 * @example
 * ```ts
 * yjsPath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/yjs/epicenter-fuji.db'
 * ```
 */
export function yjsPath(epicenterRoot: string, workspaceId: string): string {
	return join(epicenterStateDir(epicenterRoot), 'yjs', `${workspaceId}.db`);
}

/**
 * Convention path for a workspace's SQLite mirror file (the queryable SQL surface).
 *
 * Convention: `<epicenterRoot>/.epicenter/sqlite/<workspaceId>.db`. The vault mount
 * factories always use this guid-keyed default; a non-vault caller can still pass
 * a custom `filePath` to `attachBunSqliteMaterializer`, in which case scripts must
 * open that explicit path with `openSqliteReader({ filePath })`.
 *
 * Distinct from `yjsPath`: the yjs file is the role (durability of the
 * Y.Doc update log; SQLite is implementation detail and you never open it
 * with `sqlite3`). This file is the surface (you open it with `sqlite3`
 * to run SELECT and FTS5 queries; that's its whole point). Different
 * shape, different concurrency profile, different consumers.
 *
 * @example
 * ```ts
 * sqlitePath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/sqlite/epicenter-fuji.db'
 * ```
 */
export function sqlitePath(epicenterRoot: string, workspaceId: string): string {
	return join(epicenterStateDir(epicenterRoot), 'sqlite', `${workspaceId}.db`);
}

/**
 * Legacy root directory for a workspace's hidden markdown materializer tree.
 *
 * Convention: `<epicenterRoot>/.epicenter/md/<workspaceId>/` (hidden). Retained
 * for the playground daemons that still import it. First-party app mounts now
 * pass the app folder itself to the visible markdown exporter, which writes
 * table-named directories such as `<epicenterRoot>/entries/`.
 *
 * @example
 * ```ts
 * markdownPath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/md/epicenter-fuji'
 * ```
 */
export function markdownPath(
	epicenterRoot: string,
	workspaceId: string,
): string {
	return join(epicenterStateDir(epicenterRoot), 'md', workspaceId);
}
