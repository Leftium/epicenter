import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { openCollaboration, toWsUrl } from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { openHoneycrispDocument } from './document.js';
import { createHoneycrispActions } from './workspace.js';

export const DEFAULT_HONEYCRISP_DAEMON_ROUTE = 'honeycrisp';

export type HoneycrispDaemonOptions = {
	route?: string;
};

export function defineHoneycrispDaemon({
	route = DEFAULT_HONEYCRISP_DAEMON_ROUTE,
}: HoneycrispDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openHoneycrispDocument({
				clientID: hashClientId(projectDir),
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			});
			const yjsLog = attachYjsLog(doc.ydoc, {
				filePath: yjsPath(projectDir, doc.ydoc.guid),
			});
			const actions = createHoneycrispActions(doc.tables);
			const collaboration = openCollaboration(doc.ydoc, {
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
				openWebSocket: auth.openWebSocket,
				identity: {
					id: 'honeycrisp-daemon',
					name: 'Honeycrisp Daemon',
					platform: 'node',
				},
				actions,
			});

			return {
				ydoc: doc.ydoc,
				tables: doc.tables,
				kv: doc.kv,
				batch: doc.batch,
				yjsLog,
				collaboration,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	};
}
