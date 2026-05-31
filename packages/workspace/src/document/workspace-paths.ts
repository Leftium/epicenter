/**
 * Per-workspace data layout helpers.
 *
 * Conventional folders under `<projectDir>/.epicenter/`, each named by what's
 * inside:
 *
 *   yjs/<id>.db     Yjs CRDT update log (durability; replayed by Yjs)
 *   sqlite/<id>.db  Queryable SQL surface (open with `sqlite3`, FTS5)
 *   md/<id>/        Markdown surface (open with your editor)
 *
 * Mounts may override materializer paths. These helpers return the default
 * convention only; they do not inspect `epicenter.config.ts`.
 *
 * For daemon-process paths (sockets, log, metadata sidecar), see
 * `daemon/paths.ts`. Different audience, different rationale.
 *
 * Pure helpers: no side effects, no directory creation. Consumers do their
 * own `mkdir` (or rely on the attachments to do it).
 */

import { isAbsolute, join } from 'node:path';

function epicenterProjectDir(projectDir: string): string {
	return join(projectDir, '.epicenter');
}

/**
 * Resolve a user-supplied path override from `epicenter.config.ts` into an
 * absolute path: absolute overrides pass through, relative ones resolve
 * against the project root. Returns `undefined` when no override is given, so
 * a mount can fall back to the library convention with `?? sqlitePath(...)`.
 *
 * @example
 * ```ts
 * resolveProjectPath('/vault', 'notes')            // '/vault/notes'
 * resolveProjectPath('/vault', '/tmp/notes')       // '/tmp/notes'
 * resolveProjectPath('/vault', undefined)          // undefined
 * ```
 */
export function resolveProjectPath(
	projectDir: string,
	override: string | undefined,
): string | undefined {
	if (override === undefined) return undefined;
	return isAbsolute(override) ? override : join(projectDir, override);
}

/**
 * Path to a workspace's Yjs CRDT update log.
 *
 * Convention: `<projectDir>/.epicenter/yjs/<workspaceId>.db`. This file is the
 * source of truth: every `updateV2` event lands here as a row, and the
 * file is replayed at startup to reconstruct the Y.Doc. SQLite is the
 * implementation detail; you never query this file with `sqlite3`. For
 * the queryable surface, see `sqlitePath`.
 *
 * `projectDir` is the project root (where `epicenter.config.ts` lives);
 * `workspaceId` is `ws.ydoc.guid`.
 *
 * @example
 * ```ts
 * yjsPath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/yjs/epicenter-fuji.db'
 * ```
 */
export function yjsPath(projectDir: string, workspaceId: string): string {
	return join(epicenterProjectDir(projectDir), 'yjs', `${workspaceId}.db`);
}

/**
 * Convention path for a workspace's SQLite mirror file (the queryable SQL surface).
 *
 * Convention: `<projectDir>/.epicenter/sqlite/<workspaceId>.db`. A mount can
 * pass a custom `sqliteFile` to `attachBunSqliteMaterializer`; scripts must then
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
export function sqlitePath(projectDir: string, workspaceId: string): string {
	return join(epicenterProjectDir(projectDir), 'sqlite', `${workspaceId}.db`);
}

/**
 * Root directory for a workspace's markdown materializer tree.
 *
 * Convention: `<projectDir>/.epicenter/md/<workspaceId>/`. A mount can pass a
 * custom markdown directory to `attachMarkdownMaterializer`. For Fuji today,
 * markdown is a derived projection of root row frontmatter plus app-owned body
 * doc text, not the canonical import source for entry bodies.
 *
 * @example
 * ```ts
 * markdownPath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/md/epicenter-fuji'
 * ```
 */
export function markdownPath(projectDir: string, workspaceId: string): string {
	return join(epicenterProjectDir(projectDir), 'md', workspaceId);
}
