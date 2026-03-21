/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB
 * persistence, encryption, and WebSocket sync.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { createApps } from '@epicenter/constants/apps';
import { tokenStore } from '$lib/auth/token-store';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { honeycrisp } from './schema';

const API_URL = createApps('production').API.URL;

const workspace = createWorkspace(honeycrisp)
	.withEncryption({})
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${API_URL}/workspaces/${workspaceId}`,
			getToken: async () => tokenStore.get(),
		}),
	);

export default workspace;
