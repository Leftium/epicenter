import { createMachineAuthClient, requireSession } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachYjsLog,
	hashClientId,
	markdownPath,
	openWriterSqlite,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import {
	createFujiActions,
	FUJI_WORKSPACE_ID,
	fujiTables,
} from './workspace.js';

export function defineFujiDaemon({ route = 'fuji' }: { route?: string } = {}) {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const session = requireSession(auth);
			const ydoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
			ydoc.clientID = hashClientId(projectDir);
			const encryption = attachEncryption(ydoc, {
				encryptionKeys: () => session.encryptionKeys,
			});
			const tables = encryption.attachTables(fujiTables);
			encryption.attachKv({});
			const yjsLog = attachYjsLog(ydoc, {
				filePath: yjsPath(projectDir, ydoc.guid),
			});
			const actions = createFujiActions(tables);
			const collaboration = openCollaboration(ydoc, {
				url: roomWsUrl(EPICENTER_API_URL, ydoc.guid),
				openWebSocket: session.openWebSocket,
				replicaId: 'fuji-daemon',
				actions,
			});
			const sqliteDb = openWriterSqlite({
				filePath: sqlitePath(projectDir, ydoc.guid),
				log: createLogger('fuji-sqlite'),
			});
			ydoc.once('destroy', () => sqliteDb.close());
			attachSqliteMaterializer(ydoc, { db: sqliteDb }).table(tables.entries);
			attachMarkdownMaterializer(ydoc, {
				dir: markdownPath(projectDir, ydoc.guid),
			}).table(tables.entries, { filename: slugFilename('title') });

			return {
				collaboration,
				yjsLog,
				async [Symbol.asyncDispose]() {
					ydoc.destroy();
					await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	} satisfies DaemonRouteDefinition;
}
