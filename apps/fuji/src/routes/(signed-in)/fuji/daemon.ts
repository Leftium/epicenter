import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	openWorkspace,
	type ProjectDir,
	toWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachYjsLog,
	connectDaemonActions,
	hashClientId,
	markdownPath,
	openWriterSqlite,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { openFuji as openFujiDoc } from './index.js';
import type { createFujiActions } from './workspace.js';

export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';

export type FujiDaemonOptions = {
	route?: string;
};

export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
}: FujiDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openFujiDoc({
				clientID: hashClientId(projectDir),
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			});
			const yjsLog = attachYjsLog(doc.ydoc, {
				filePath: yjsPath(projectDir, doc.ydoc.guid),
			});
			const workspace = openWorkspace(doc.ydoc, {
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
				openWebSocket: auth.openWebSocket,
				identity: {
					id: 'fuji-daemon',
					name: 'Fuji Daemon',
					platform: 'node',
				},
				actions: doc.actions,
			});
			const sqliteDb = openWriterSqlite({
				filePath: sqlitePath(projectDir, doc.ydoc.guid),
				log: createLogger('fuji-sqlite'),
			});
			doc.ydoc.once('destroy', () => sqliteDb.close());
			attachSqliteMaterializer(doc.ydoc, { db: sqliteDb }).table(
				doc.tables.entries,
			);
			attachMarkdownMaterializer(doc.ydoc, {
				dir: markdownPath(projectDir, doc.ydoc.guid),
			}).table(doc.tables.entries, { filename: slugFilename('title') });

			return {
				workspace,
				yjsLog,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await Promise.all([workspace.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	};
}

export function connectFujiDaemonActions({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	projectDir,
}: {
	route?: string;
	projectDir?: ProjectDir;
} = {}) {
	return connectDaemonActions<ReturnType<typeof createFujiActions>>({
		route,
		projectDir,
	});
}
