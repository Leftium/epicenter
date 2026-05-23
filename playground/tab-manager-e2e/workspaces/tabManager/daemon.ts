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
	defineActions,
	openCollaboration,
	openEncryptedDoc,
	roomWsUrl,
} from '@epicenter/workspace';
import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachYjsLog, markdownPath, yjsPath } from '@epicenter/workspace/node';

const SERVER_URL = 'https://api.epicenter.so';
const WORKSPACE_ID = 'epicenter.tab-manager';

export default defineDaemonWorkspace({
	async open(ctx) {
		const ws = openEncryptedDoc({
			id: WORKSPACE_ID,
			keyring: ctx.keyring,
			clientId: ctx.clientId,
		});
		const tables = ws.attachTables(tabManagerTables);
		const kv = ws.attachKv({});

		const persistence = attachYjsLog(ws.ydoc, {
			filePath: yjsPath(ctx.projectDir, WORKSPACE_ID),
		});

		const actions = defineActions({});

		const collaboration = openCollaboration(ws.ydoc, {
			url: roomWsUrl(SERVER_URL, ws.ydoc.guid),
			openWebSocket: ctx.openWebSocket,
			installationId: ctx.installationId,
			actions,
		});

		const whenReady = collaboration.whenConnected;
		const markdown = attachMarkdownMaterializer(ws.ydoc, {
			dir: markdownPath(ctx.projectDir, WORKSPACE_ID),
			waitFor: whenReady,
		})
			.table(tables.savedTabs, { filename: slugFilename('title') })
			.table(tables.bookmarks, { filename: slugFilename('title') })
			.table(tables.devices)
			.kv(kv);

		return {
			workspaceId: ws.ydoc.guid,
			whenReady,
			actions,
			collaboration,
			async [Symbol.asyncDispose]() {
				ws[Symbol.dispose]();
				await collaboration.whenDisposed;
			},
			id: WORKSPACE_ID,
			ydoc: ws.ydoc,
			tables,
			kv,
			persistence,
			markdown,
		};
	},
});
