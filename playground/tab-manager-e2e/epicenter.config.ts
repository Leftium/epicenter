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
import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { tabManagerTables } from '@epicenter/tab-manager';
import {
	attachEncryption,
	defineActions,
	openCollaboration,
	websocketUrl,
} from '@epicenter/workspace';
import { defineConfig } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachYjsLog, epicenterPaths } from '@epicenter/workspace/node';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const WORKSPACE_ID = 'epicenter.tab-manager';

const auth = await createMachineAuthClient();

const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: false });
const encryption = attachEncryption(ydoc, {
	encryptionKeys: () => requireIdentity(auth).encryptionKeys,
});
const tables = encryption.attachTables(tabManagerTables);
// Empty kv: tabManager has no KV definitions, but `.kv()` on the materializer
// serializes the shared kv store. Keep an empty encrypted kv attached so the
// materializer's `.kv()` call has something to observe.
const kv = encryption.attachKv({});

const persistence = attachYjsLog(ydoc, {
	filePath: epicenterPaths.persistence(WORKSPACE_ID),
});

const actions = defineActions({});

const collaboration = openCollaboration(ydoc, {
	url: websocketUrl(`${SERVER_URL}/workspaces/${ydoc.guid}`),
	openWebSocket: auth.openWebSocket,
	replicaId: 'tab-manager-playground-daemon',
	actions,
});

const whenReady = collaboration.whenConnected;

const markdown = attachMarkdownMaterializer(ydoc, {
	dir: MARKDOWN_DIR,
	waitFor: whenReady,
})
	.table(tables.savedTabs, { filename: slugFilename('title') })
	.table(tables.bookmarks, { filename: slugFilename('title') })
	.table(tables.devices)
	.kv(kv);

export const tabManager = {
	workspaceId: ydoc.guid,
	whenReady,
	actions,
	collaboration,
	async [Symbol.asyncDispose]() {
		ydoc.destroy();
		await collaboration.whenDisposed;
	},
	// Extras for direct script use, not part of the hosted daemon runtime contract.
	id: WORKSPACE_ID,
	ydoc,
	tables,
	kv,
	encryption,
	persistence,
	markdown,
};

export default defineConfig({
	daemon: {
		routes: [{ route: 'tabManager', start: () => tabManager }],
	},
});
