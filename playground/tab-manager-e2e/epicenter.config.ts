/**
 * E2E playground config: syncs the tab-manager workspace from the Epicenter API
 * down to local persistence (SQLite) and materializes to markdown files.
 *
 * Reads auth credentials (token + encryption keys) from the CLI session store
 * at `~/.epicenter/auth/sessions.json`—run `epicenter auth login` first.
 *
 * Composes a DocumentBundle by calling `attach*` primitives directly on a
 * Y.Doc. For a `defineDocument((id) => { ... }).open(id)` variant, see
 * `apps/whispering/src/lib/client.ts`.
 *
 * Usage:
 *   epicenter start playground/tab-manager-e2e --verbose
 *   epicenter list savedTabs -C playground/tab-manager-e2e
 */

import { join } from 'node:path';
import { createSessionStore, EPICENTER_PATHS } from '@epicenter/cli';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from '@epicenter/tab-manager/workspace';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
	attachSqlite,
	attachSync,
} from '@epicenter/workspace';
import {
	createMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const WORKSPACE_ID = 'epicenter.tab-manager';

const sessions = createSessionStore();

const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: false });
const encryption = attachEncryption(ydoc);
const tables = attachEncryptedTables(ydoc, encryption, tabManagerTables);
// Empty kv — tabManager has no KV definitions, but `.kv()` on the materializer
// serializes the shared kv store. Keep an empty encrypted kv attached so the
// materializer's `.kv()` call has something to observe.
const kv = attachEncryptedKv(ydoc, encryption, {});

const persistence = attachSqlite(ydoc, {
	filePath: EPICENTER_PATHS.persistence(WORKSPACE_ID),
});

// Inline the old `createCliUnlock`: load the session after persistence
// hydrates, then apply encryption keys from it (if any).
const whenUnlocked = (async () => {
	await persistence.whenLoaded;
	const session = await sessions.load(SERVER_URL);
	if (session?.encryptionKeys) {
		encryption.applyKeys(session.encryptionKeys);
	}
})();

const sync = attachSync(ydoc, {
	url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
	getToken: async () => (await sessions.load(SERVER_URL))?.accessToken ?? null,
	// Gate connection on local hydrate + unlock so the handshake only exchanges
	// the delta, not the whole document.
	waitFor: Promise.all([persistence.whenLoaded, whenUnlocked]),
});

const whenReady = Promise.all([
	persistence.whenLoaded,
	whenUnlocked,
	sync.whenConnected,
]).then(() => {});

const markdown = createMarkdownMaterializer(
	{ tables, kv, whenReady },
	{ dir: MARKDOWN_DIR },
)
	.table('savedTabs', { serialize: slugFilename('title') })
	.table('bookmarks', { serialize: slugFilename('title') })
	.table('devices')
	.kv();

export const tabManager = {
	id: WORKSPACE_ID,
	ydoc,
	tables,
	kv,
	awarenessDefs: tabManagerAwarenessDefs,
	encryption,
	persistence,
	sync,
	markdown,
	whenReady,
	whenDisposed: Promise.all([persistence.whenDisposed, sync.whenDisposed]).then(
		() => {},
	),
	[Symbol.dispose]() {
		ydoc.destroy();
	},
};
