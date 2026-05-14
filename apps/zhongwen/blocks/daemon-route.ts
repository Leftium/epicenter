import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	websocketUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { zhongwenKv, zhongwenTables } from './workspace.js';
import * as Y from 'yjs';

export const DEFAULT_ZHONGWEN_DAEMON_ROUTE = 'zhongwen';

export function defineZhongwenDaemon({
	route = DEFAULT_ZHONGWEN_DAEMON_ROUTE,
}: {
	route?: string;
} = {}) {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
			ydoc.clientID = hashClientId(projectDir);
			const encryption = attachEncryption(ydoc, {
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			});
			const tables = encryption.attachTables(zhongwenTables);
			const kv = encryption.attachKv(zhongwenKv);
			const yjsLog = attachYjsLog(ydoc, {
				filePath: yjsPath(projectDir, ydoc.guid),
			});
			const collaboration = openCollaboration(ydoc, {
				url: websocketUrl(`${EPICENTER_API_URL}/workspaces/${ydoc.guid}`),
				openWebSocket: auth.openWebSocket,
				replica: { id: 'zhongwen-daemon', platform: 'node' },
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
