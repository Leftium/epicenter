/**
 * Pre-built workspace extension factories for CLI-backed configs.
 *
 * The CLI has no interactive auth system (no `createAuth` with `onLogin`).
 * Instead, credentials are stored on disk by `epicenter auth login` and
 * loaded eagerly during workspace initialization. `createCliUnlock` is the
 * CLI equivalent of the browser's `onLogin → applyEncryptionKeys` pattern.
 */

import type { ExtensionContext } from '@epicenter/workspace';
import type { createSessionStore } from './auth/store.js';

type SessionStore = ReturnType<typeof createSessionStore>;

type UnlockContext = Pick<ExtensionContext, 'init' | 'applyEncryptionKeys'>;

/**
 * Create an encryption unlock extension that loads keys from the CLI session store.
 *
 * Waits for all prior extensions to initialize, then loads the session for
 * the given server URL and applies encryption keys if present. Register with
 * `.withExtension('unlock', ...)`.
 *
 * @param sessions - Session store created by `createSessionStore()`
 * @param serverUrl - Server URL to load the session for
 *
 * @example
 * ```typescript
 * import { createSessionStore, createCliUnlock } from '@epicenter/cli';
 *
 * const sessions = createSessionStore();
 *
 * const workspace = createWorkspace(definition)
 *   .withExtension('unlock', createCliUnlock(sessions, SERVER_URL));
 * ```
 */
export function createCliUnlock(sessions: SessionStore, serverUrl: string) {
	return (ctx: UnlockContext) => ({
		exports: {},
		init: (async () => {
			await ctx.init;
			const session = await sessions.load(serverUrl);
			if (session?.encryptionKeys) {
				ctx.applyEncryptionKeys(session.encryptionKeys);
			}
		})(),
	});
}
