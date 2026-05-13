import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { openWorkspace, toWsUrl } from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { openZhongwen as openZhongwenDoc } from './index.js';

export const DEFAULT_ZHONGWEN_DAEMON_ROUTE = 'zhongwen';

export type ZhongwenDaemonOptions = {
	route?: string;
};

export function defineZhongwenDaemon({
	route = DEFAULT_ZHONGWEN_DAEMON_ROUTE,
}: ZhongwenDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openZhongwenDoc({
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
					id: 'zhongwen-daemon',
					name: 'Zhongwen Daemon',
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
