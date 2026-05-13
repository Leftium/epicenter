import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	toWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { opensidianTables } from './workspace.js';
import * as Y from 'yjs';

export const DEFAULT_OPENSIDIAN_DAEMON_ROUTE = 'opensidian';

export function defineOpensidianDaemon({
	route = DEFAULT_OPENSIDIAN_DAEMON_ROUTE,
}: {
	route?: string;
} = {}) {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const ydoc = new Y.Doc({ guid: 'epicenter.opensidian', gc: false });
			ydoc.clientID = hashClientId(projectDir);
			const encryption = attachEncryption(ydoc, {
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			});
			const tables = encryption.attachTables(opensidianTables);
			const kv = encryption.attachKv({});
			const yjsLog = attachYjsLog(ydoc, {
				filePath: yjsPath(projectDir, ydoc.guid),
			});

			// Daemon runtime is sync-only for now: no actions and no materializers.
			// Browser runtime owns Opensidian file and shell actions because they
			// need browser services.
			const collaboration = openCollaboration(ydoc, {
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${ydoc.guid}`),
				openWebSocket: auth.openWebSocket,
				identity: {
					id: 'opensidian-daemon',
					name: 'Opensidian Daemon',
					platform: 'node',
				},
				actions: {},
			});

			return {
				ydoc,
				tables,
				kv,
				batch: (fn: () => void) => ydoc.transact(fn),
				yjsLog,
				collaboration,
				async [Symbol.asyncDispose]() {
					ydoc.destroy();
					await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	} satisfies DaemonRouteDefinition;
}
