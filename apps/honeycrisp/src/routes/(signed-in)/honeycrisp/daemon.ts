import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { openWorkspace, toWsUrl } from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

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
			const doc = openHoneycrispDoc({
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
					id: 'honeycrisp-daemon',
					name: 'Honeycrisp Daemon',
					platform: 'node',
				},
				actions: doc.actions,
			});

			return {
				...doc,
				yjsLog,
				workspace,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await Promise.all([workspace.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	};
}
