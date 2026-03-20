/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB
 * persistence, encryption, and WebSocket sync.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { createApps } from '@epicenter/constants/apps';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { honeycrisp } from './schema';

const API_URL = createApps('production').API.URL;

/**
 * Mutable token provider set by the auth module after initialization.
 * The sync extension calls this lazily at connection time, not at
 * construction time, so the auth module has time to set it up.
 */
let tokenProvider: (() => string | undefined) | undefined;

/** Called by the auth module to wire the token provider. */
export function setTokenProvider(fn: () => string | undefined) {
	tokenProvider = fn;
}

// Assign to const so TypeScript resolves the full builder type
// (including EncryptionMethods from .withEncryption).
const workspace = createWorkspace(honeycrisp)
	.withEncryption({})
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${API_URL}/workspaces/${workspaceId}`,
			getToken: async () => tokenProvider?.(),
		}),
	);

export default workspace;
