/**
 * E2E playground daemon: syncs the Tab Manager workspace from the Epicenter
 * API to local persistence and markdown files.
 *
 * Run with:
 *
 * ```bash
 * epicenter daemon up -C playground/tab-manager-e2e
 * ```
 */

import { tabManagerTables } from '@epicenter/tab-manager';
import {
	attachEncryption,
	defineActions,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachYjsLog, markdownPath, yjsPath } from '@epicenter/workspace/node';
import * as Y from 'yjs';

const SERVER_URL = 'https://api.epicenter.so';
const WORKSPACE_ID = 'epicenter.tab-manager';

export default defineDaemonWorkspace({
	async open(ctx) {
		const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: true });
		ydoc.clientID = ctx.clientId;
		const encryption = attachEncryption(ydoc, { keyring: ctx.keyring });
		const tables = encryption.attachTables(tabManagerTables);
		const kv = encryption.attachKv({});

		const persistence = attachYjsLog(ydoc, {
			filePath: yjsPath(ctx.projectDir, WORKSPACE_ID),
		});

		const actions = defineActions({});

		const collaboration = openCollaboration(ydoc, {
			url: roomWsUrl(SERVER_URL, ydoc.guid),
			openWebSocket: ctx.openWebSocket,
			installationId: ctx.installationId,
			actions,
		});

		const whenReady = collaboration.whenConnected;
		const markdown = attachMarkdownMaterializer(ydoc, {
			dir: markdownPath(ctx.projectDir, WORKSPACE_ID),
			waitFor: whenReady,
		})
			.table(tables.savedTabs, { filename: slugFilename('title') })
			.table(tables.bookmarks, { filename: slugFilename('title') })
			.table(tables.devices)
			.kv(kv);

		return {
			workspaceId: ydoc.guid,
			whenReady,
			actions,
			collaboration,
			async [Symbol.asyncDispose]() {
				ydoc.destroy();
				await collaboration.whenDisposed;
			},
			id: WORKSPACE_ID,
			ydoc,
			tables,
			kv,
			persistence,
			markdown,
		};
	},
});
