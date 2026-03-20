/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB
 * persistence, encryption, and WebSocket sync.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 *
 * Sync connects after persistence loads. The `getToken` callback reads
 * from auth state lazily—no circular import because it's called at
 * connection time, not at construction time.
 */

import { createApps } from '@epicenter/constants/apps';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { honeycrisp } from './schema';

const API_URL = createApps('production').API.URL;

export default createWorkspace(honeycrisp)
	.withEncryption({})
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${API_URL}/workspaces/${workspaceId}`,
			getToken: async () => {
				// Lazy import to break circular dependency:
				// workspace -> auth (for token) and auth -> workspace (for callbacks).
				// The dynamic import only runs at connection time, not at module load.
				const { authState } = await import('$lib/auth');
				return authState.token;
			},
		}),
	);
