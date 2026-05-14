import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	toWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import * as Y from 'yjs';
import { createHoneycrispActions, honeycrispTables } from './workspace.js';

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
			const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
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
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${ydoc.guid}`),
				openWebSocket: auth.openWebSocket,
				identity: {
					id: 'honeycrisp-daemon',
					name: 'Honeycrisp Daemon',
					platform: 'node',
				},
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
