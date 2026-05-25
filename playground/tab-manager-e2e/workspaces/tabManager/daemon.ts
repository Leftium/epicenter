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

import { createTabManagerWorkspace } from '@epicenter/tab-manager';
import {
	defineActions,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachYjsLog, markdownPath, yjsPath } from '@epicenter/workspace/node';

const SERVER_URL = 'https://api.epicenter.so';

export default defineWorkspace({
	async open({
		projectDir,
		yDocClientId,
		deviceId,
		ownerId,
		keyring,
		openWebSocket,
		onReconnectSignal,
	}) {
		const workspace = createTabManagerWorkspace({ keyring });
		workspace.ydoc.clientID = yDocClientId;
		const { ydoc, tables, kv } = workspace;

		const persistence = attachYjsLog(ydoc, {
			filePath: yjsPath(projectDir, ydoc.guid),
		});

		const actions = defineActions({});

		const collaboration = openCollaboration(ydoc, {
			url: roomWsUrl({
				baseURL: SERVER_URL,
				ownerId,
				guid: ydoc.guid,
				deviceId,
			}),
			openWebSocket,
			onReconnectSignal,
			actions,
		});

		const whenReady = collaboration.whenConnected;
		const markdown = attachMarkdownMaterializer(workspace, {
			dir: markdownPath(projectDir, ydoc.guid),
			waitFor: whenReady,
			perTable: {
				savedTabs: { filename: slugFilename('title') },
				bookmarks: { filename: slugFilename('title') },
				devices: {},
			},
		});

		return {
			workspaceId: ydoc.guid,
			whenReady,
			actions,
			collaboration,
			async [Symbol.asyncDispose]() {
				workspace[Symbol.dispose]();
				await collaboration.whenDisposed;
			},
			ydoc,
			tables,
			kv,
			persistence,
			markdown,
		};
	},
});
