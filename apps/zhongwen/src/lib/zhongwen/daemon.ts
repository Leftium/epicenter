import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { createMachineTokenGetter } from '@epicenter/auth/node';
import {
	attachAwareness,
	attachSync,
	createRemoteClient,
	PeerIdentity,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { openZhongwen as openZhongwenDoc } from './index.js';

export const DEFAULT_ZHONGWEN_DAEMON_ROUTE = 'zhongwen';

export type ZhongwenDaemonOptions = {
	route?: string;
	getToken?: () => Promise<string | null>;
	peer?: PeerIdentity;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultZhongwenDaemonPeer(): PeerIdentity {
	return {
		id: 'zhongwen-daemon',
		name: 'Zhongwen Daemon',
		platform: 'node',
	};
}

export function defineZhongwenDaemon({
	route = DEFAULT_ZHONGWEN_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createMachineTokenGetter({ serverOrigin: apiUrl }),
	peer = defaultZhongwenDaemonPeer(),
	webSocketImpl,
}: ZhongwenDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		start({ projectDir }) {
			const doc = openZhongwenDoc({ clientID: hashClientId(projectDir) });
			const yjsLog = attachYjsLog(doc.ydoc, {
				filePath: yjsPath(projectDir, doc.ydoc.guid),
			});
			const awareness = attachAwareness(doc.ydoc, {
				schema: { peer: PeerIdentity },
				initial: { peer },
			});
			const sync = attachSync(doc, {
				url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
				getToken,
				webSocketImpl,
				awareness,
			});
			const actions = {};
			const rpc = sync.attachRpc(actions);
			const remote = createRemoteClient({ awareness, rpc });

			return {
				...doc,
				yjsLog,
				awareness,
				sync,
				remote,
				rpc,
				actions,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await sync.whenDisposed;
				},
			};
		},
	};
}
