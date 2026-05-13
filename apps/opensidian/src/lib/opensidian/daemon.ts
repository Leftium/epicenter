import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { openWorkspace, toWsUrl } from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { openOpensidian as openOpensidianDoc } from './index.js';

export const DEFAULT_OPENSIDIAN_DAEMON_ROUTE = 'opensidian';

export type OpensidianDaemonOptions = {
	route?: string;
};

export function defineOpensidianDaemon({
	route = DEFAULT_OPENSIDIAN_DAEMON_ROUTE,
}: OpensidianDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openOpensidianDoc({
				clientID: hashClientId(projectDir),
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			});
			const yjsLog = attachYjsLog(doc.ydoc, {
				filePath: yjsPath(projectDir, doc.ydoc.guid),
			});

			// Daemon runtime is materializer-only for now. Browser runtime owns
			// Opensidian file and shell actions because they need browser services.
			const workspace = openWorkspace(doc.ydoc, {
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
				openWebSocket: auth.openWebSocket,
				identity: {
					id: 'opensidian-daemon',
					name: 'Opensidian Daemon',
					platform: 'node',
				},
				actions: {},
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
