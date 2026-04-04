/**
 * E2E test config: syncs the tab-manager workspace from the Epicenter API
 * down to local persistence (SQLite .db file) with encryption.
 *
 * Reads auth credentials (token + encryption keys) from the CLI session store
 * at `~/.epicenter/auth/sessions.json`—run `epicenter auth login` first.
 *
 * Usage:
 *   epicenter start playground/tab-manager-e2e --verbose
 *   epicenter list savedTabs -C playground/tab-manager-e2e
 */

import { join } from 'node:path';
import { createSessionStore, resolveEpicenterHome } from '@epicenter/cli';
import { createTabManagerWorkspace } from '@epicenter/tab-manager/workspace';
import {
	markdownMaterializer,
	titleFilenameSerializer,
} from '@epicenter/workspace/extensions/materializer/markdown';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';

const SERVER_URL = 'https://api.epicenter.so';
const PERSISTENCE_DIR = join(import.meta.dir, '.epicenter', 'persistence');
const MARKDOWN_DIR = join(import.meta.dir, 'data');

const sessions = createSessionStore(resolveEpicenterHome());

export const tabManager = createTabManagerWorkspace()
	.withExtension(
		'persistence',
		filesystemPersistence({
			filePath: join(PERSISTENCE_DIR, 'epicenter.tab-manager.db'),
		}),
	)
	.withWorkspaceExtension(
		'markdown',
		markdownMaterializer({
			directory: MARKDOWN_DIR,
			tables: {
				savedTabs: { serializer: titleFilenameSerializer('title') },
				bookmarks: { serializer: titleFilenameSerializer('title') },
				devices: {},
			},
		}),
	)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
			getToken: async () => {
				const session = await sessions.load(SERVER_URL);
				return session?.accessToken ?? null;
			},
		}),
	);

// Apply encryption keys from the stored session (no separate cache needed—
// the session store already persists keys from the login flow).
sessions.load(SERVER_URL).then((session) => {
	if (session?.encryptionKeys) {
		tabManager.applyEncryptionKeys(session.encryptionKeys);
	}
});
