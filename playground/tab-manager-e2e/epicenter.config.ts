/**
 * E2E playground config: syncs the tab-manager workspace from the Epicenter API
 * down to local persistence (SQLite) and materializes to markdown files.
 *
 * Reads auth credentials (token + encryption keys) from the CLI session store
 * at `~/.epicenter/auth/sessions.json`—run `epicenter auth login` first.
 *
 * Composes a DocumentBundle via `createDocumentFactory((id) => ...).open(id)` so the
 * handle carries the `DOCUMENT_HANDLE` brand that `loadConfig` checks for.
 *
 * Usage:
 *   # Run the workspace — imports this config, which opens the handle,
 *   # which starts persistence + sync + markdown materialization. Runs
 *   # until Ctrl+C.
 *   bun run playground/tab-manager-e2e/epicenter.config.ts
 *
 *   # `epicenter list` against this config shows an empty tree — no
 *   # defineQuery/defineMutation wrappers are attached. Add them to the
 *   # bundle if you want CLI-addressable operations.
 */

import { join } from 'node:path';
import {
	attachSessionUnlock,
	createSessionStore,
	EPICENTER_PATHS,
} from '@epicenter/cli';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from '@epicenter/tab-manager/workspace';
import {
	attachEncryption,
	attachSqlite,
	attachSync,
	createDocumentFactory,
} from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const WORKSPACE_ID = 'epicenter.tab-manager';

const sessions = createSessionStore();

const tabManagerFactory = createDocumentFactory((id: string) => {
	const ydoc = new Y.Doc({ guid: id, gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, tabManagerTables);
	// Empty kv — tabManager has no KV definitions, but `.kv()` on the materializer
	// serializes the shared kv store. Keep an empty encrypted kv attached so the
	// materializer's `.kv()` call has something to observe.
	const kv = encryption.attachKv(ydoc, {});

	const persistence = attachSqlite(ydoc, {
		filePath: EPICENTER_PATHS.persistence(id),
	});

	const unlock = attachSessionUnlock(encryption, {
		sessions,
		serverUrl: SERVER_URL,
		waitFor: persistence.whenLoaded,
	});

	const sync = attachSync(ydoc, {
		url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
		// Gate connection on local hydrate + unlock so the handshake only exchanges
		// the delta, not the whole document.
		waitFor: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
	});
	void (async () => {
		const loaded = await sessions.load(SERVER_URL);
		sync.setToken(loaded?.accessToken ?? null);
		sync.reconnect();
	})();

	const whenReady = Promise.all([
		persistence.whenLoaded,
		unlock.whenChecked,
		sync.whenConnected,
	]).then(() => {});

	const markdown = attachMarkdownMaterializer(
		{ tables, kv, whenReady },
		{ dir: MARKDOWN_DIR },
	)
		.table('savedTabs', { filename: slugFilename('title') })
		.table('bookmarks', { filename: slugFilename('title') })
		.table('devices')
		.kv();

	return {
		id,
		ydoc,
		tables,
		kv,
		awarenessDefs: tabManagerAwarenessDefs,
		encryption,
		persistence,
		sync,
		markdown,
		whenReady,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

export const tabManager = tabManagerFactory.open(WORKSPACE_ID);
