/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB
 * persistence, encryption, and WebSocket sync.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { authState } from '$lib/auth';
import { honeycrisp } from './schema';

const workspace = createWorkspace(honeycrisp)
	.withEncryption({})
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${APP_URLS.API}/workspaces/${workspaceId}`,
			getToken: async () => authState.token,
			onTokenChange: (reconnect) => {
				let prev = authState.token;
				return $effect.root(() => {
					$effect(() => {
						const token = authState.token;
						if (token !== prev) { prev = token; reconnect(); }
					});
				});
			},
		}),
	);

export default workspace;
