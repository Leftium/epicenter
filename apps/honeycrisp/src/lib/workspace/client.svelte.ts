/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB
 * persistence, encryption, and WebSocket sync.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createWorkspaceAuthBoundary } from '@epicenter/svelte/auth';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { authState } from '$lib/auth';
import { userKeyCache } from './user-key-cache';
import { honeycrisp } from './schema';

const workspace = createWorkspace(honeycrisp)
	.withEncryption({ userKeyCache })
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${APP_URLS.API}/workspaces/${workspaceId}`,
			getToken: async () =>
				authState.session.status === 'authenticated'
					? authState.session.token
					: null,
		}),
	);

export const workspaceAuth = createWorkspaceAuthBoundary({
	workspace,
	auth: authState,
	reconnect: () => workspace.extensions.sync.reconnect(),
});

export default workspace;
