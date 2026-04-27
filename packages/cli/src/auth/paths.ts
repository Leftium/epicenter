/**
 * Centralized path constants for the Epicenter CLI.
 *
 * Single source of truth for every file location under `~/.epicenter/`.
 * Auth and persistence are global (under `$EPICENTER_HOME`).
 * Materialization is always project-local—handled by each config, not here.
 *
 * Override the home directory by setting `$EPICENTER_HOME`.
 *
 * @example
 * ```typescript
 * import { epicenterPaths } from '@epicenter/cli';
 *
 * epicenterPaths.home()
 * // → '/Users/braden/.epicenter'
 *
 * epicenterPaths.authSessions()
 * // → '/Users/braden/.epicenter/auth/sessions.json'
 *
 * epicenterPaths.persistence('epicenter.fuji')
 * // → '/Users/braden/.epicenter/persistence/epicenter.fuji.db'
 * ```
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { runtimeDir } from '../daemon/paths.js';

/** Resolve the Epicenter home directory. Not exported—use `epicenterPaths.home()`. */
function resolveHome(): string {
	return Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

/**
 * Grouped path resolution for all files under `~/.epicenter/`.
 *
 * Each method calls `resolveHome()` directly—no `this` references—so
 * destructuring is safe: `const { persistence } = epicenterPaths`.
 */
export const epicenterPaths = {
	/**
	 * The Epicenter home directory.
	 *
	 * Resolution order: `$EPICENTER_HOME` env → `~/.epicenter/`.
	 * All other paths are relative to this.
	 *
	 * @example
	 * ```typescript
	 * const home = epicenterPaths.home();
	 * // → '/Users/braden/.epicenter'
	 * ```
	 */
	home() {
		return resolveHome();
	},

	/**
	 * Path to the auth sessions file.
	 *
	 * Stores server-keyed auth sessions (access tokens, encryption keys, user info)
	 * persisted by `epicenter auth login`. Created by `createSessionStore`.
	 *
	 * @example
	 * ```typescript
	 * epicenterPaths.authSessions()
	 * // → '/Users/braden/.epicenter/auth/sessions.json'
	 * ```
	 */
	authSessions() {
		return join(resolveHome(), 'auth', 'sessions.json');
	},

	/**
	 * Path to the persistence SQLite database for a workspace.
	 *
	 * Persistence is a cache of the Yjs workspace state—safe to delete,
	 * rebuilds from server sync on next connect. Every consumer of the same
	 * workspace ID shares the same cache file.
	 *
	 * @param workspaceId - The workspace's stable ID (e.g. `epicenter.fuji`).
	 *
	 * @example
	 * ```typescript
	 * import { sqlitePersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
	 *
	 * sqlitePersistence({ filePath: epicenterPaths.persistence('epicenter.fuji') })
	 * // → '~/.epicenter/persistence/epicenter.fuji.db'
	 * ```
	 */
	persistence(workspaceId: string) {
		return join(resolveHome(), 'persistence', `${workspaceId}.db`);
	},

	/**
	 * Runtime directory for daemon sockets and metadata sidecars.
	 *
	 * Thin wrapper over `runtimeDir()` from `daemon/paths.ts`—kept here so
	 * `epicenterPaths` remains the one-stop reference for every Epicenter
	 * filesystem location. The resolution logic (XDG vs. `~/.epicenter/run`)
	 * lives in `daemon/paths.ts` to keep a single source of truth.
	 *
	 * @example
	 * ```typescript
	 * epicenterPaths.runtime()
	 * // → '/run/user/1000/epicenter'         (Linux with XDG_RUNTIME_DIR)
	 * // → '/Users/braden/.epicenter/run'     (macOS / no XDG)
	 * ```
	 */
	runtime() {
		return runtimeDir();
	},

	/**
	 * Path to a runtime file (socket or metadata sidecar) for a given hash.
	 *
	 * The hash is the truncated sha256 of the daemon's absolute `--dir` path
	 * (see `dirHash` in `daemon/paths.ts`). Callers usually want the more
	 * specific `socketPathFor` / `metadataPathFor` helpers; this exists for
	 * iteration cases like `ps` enumerating `<runtime>/*.meta.json`.
	 *
	 * @example
	 * ```typescript
	 * epicenterPaths.runFile('abc123def4567890.sock')
	 * // → '/Users/braden/.epicenter/run/abc123def4567890.sock'
	 * ```
	 */
	runFile(hash: string) {
		return join(runtimeDir(), hash);
	},
} as const;
