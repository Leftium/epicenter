/**
 * E2E playground config: syncs the tab-manager workspace from the Epicenter API
 * down to local persistence (SQLite) and materializes to markdown files.
 *
 * Reads auth credentials from the CLI credential store at
 * `~/.epicenter/auth/credentials.json`. Run `epicenter auth login` first.
 *
 * Hosts the `tabManager` route as a full daemon peer: actions, sync,
 * presence, RPC, and disposal. `actions` is empty because the tab-manager
 * extension defines action wrappers, not this config.
 *
 * Usage:
 *   # Run the workspace. Imports this config, which constructs the
 *   # workspace, starting persistence + sync + markdown materialization.
 *   # Runs until Ctrl+C.
 *   bun run playground/tab-manager-e2e/epicenter.config.ts
 *
 *   # `epicenter list` against this config shows an empty tree.
 */

import { join } from 'node:path';
import { createDefaultCredentialStore } from '@epicenter/auth/node';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from '@epicenter/tab-manager/workspace';
import { attachEncryption, attachSync, toWsUrl } from '@epicenter/workspace';
import { defineConfig } from '@epicenter/workspace/daemon';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { epicenterPaths } from '@epicenter/workspace/node';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const WORKSPACE_ID = 'epicenter.tab-manager';

const credentials = createDefaultCredentialStore();

const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: false });
const encryption = attachEncryption(ydoc);
const tables = encryption.attachTables(ydoc, tabManagerTables);
// Empty kv: tabManager has no KV definitions, but `.kv()` on the materializer
// serializes the shared kv store. Keep an empty encrypted kv attached so the
// materializer's `.kv()` call has something to observe.
const kv = encryption.attachKv(ydoc, {});

const persistence = attachSqlite(ydoc, {
	filePath: epicenterPaths.persistence(WORKSPACE_ID),
});

const whenCredentialsApplied = persistence.whenLoaded.then(async () => {
	const keys = await credentials.getEncryptionKeys(SERVER_URL);
	if (keys) encryption.applyKeys(keys);
});

const sync = attachSync(ydoc, {
	url: toWsUrl(`${SERVER_URL}/workspaces/${ydoc.guid}`),
	// Gate connection on local hydrate + unlock so the handshake only exchanges
	// the delta, not the whole document.
	waitFor: Promise.all([persistence.whenLoaded, whenCredentialsApplied]),
	getToken: () => credentials.getBearerToken(SERVER_URL),
});

const whenReady = Promise.all([
	persistence.whenLoaded,
	whenCredentialsApplied,
	sync.whenConnected,
]);

const markdown = attachMarkdownMaterializer(
	{ tables, kv, whenReady },
	{ dir: MARKDOWN_DIR },
)
	.table('savedTabs', { filename: slugFilename('title') })
	.table('bookmarks', { filename: slugFilename('title') })
	.table('devices')
	.kv();

const actions = {};
const presence = sync.attachPresence({
	peer: {
		id: 'tab-manager-playground-daemon',
		name: 'Tab Manager Playground Daemon',
		platform: 'node',
	},
});
const rpc = sync.attachRpc(actions);

export const tabManager = {
	workspaceId: ydoc.guid,
	whenReady,
	actions,
	sync,
	presence,
	rpc,
	async [Symbol.asyncDispose]() {
		ydoc.destroy();
		await sync.whenDisposed;
	},
	// Extras for direct script use, not part of the hosted daemon runtime contract.
	id: WORKSPACE_ID,
	ydoc,
	tables,
	kv,
	awarenessDefs: tabManagerAwarenessDefs,
	encryption,
	persistence,
	markdown,
};

export default defineConfig({
	daemon: {
		routes: [{ route: 'tabManager', start: () => tabManager }],
	},
});
