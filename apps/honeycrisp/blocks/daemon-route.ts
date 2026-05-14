import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	websocketUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import * as Y from 'yjs';
import {
	createHoneycrispActions,
	HONEYCRISP_WORKSPACE_ID,
	honeycrispTables,
} from './workspace.js';

export const DEFAULT_HONEYCRISP_DAEMON_ROUTE = 'honeycrisp';

export function defineHoneycrispDaemon({
	route = DEFAULT_HONEYCRISP_DAEMON_ROUTE,
}: {
	route?: string;
} = {}) {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const ydoc = new Y.Doc({ guid: HONEYCRISP_WORKSPACE_ID, gc: false });
			ydoc.clientID = hashClientId(projectDir);
			const encryption = attachEncryption(ydoc, {
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			});
			const tables = encryption.attachTables(honeycrispTables);
			const kv = encryption.attachKv({});
			const yjsLog = attachYjsLog(ydoc, {
				filePath: yjsPath(projectDir, ydoc.guid),
			});
			const actions = createHoneycrispActions(tables);
			const collaboration = openCollaboration(ydoc, {
				url: websocketUrl(`${EPICENTER_API_URL}/workspaces/${ydoc.guid}`),
				openWebSocket: auth.openWebSocket,
				replicaId: 'honeycrisp-daemon',
				actions,
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
