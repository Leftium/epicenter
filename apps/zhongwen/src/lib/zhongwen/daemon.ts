import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerDescriptor,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import type { EpicenterConfigContext } from '@epicenter/workspace/daemon';
import {
	attachYjsLog,
	createSessionTokenGetter,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openZhongwen as openZhongwenDoc } from './index.js';

export const ZHONGWEN_DAEMON_ROUTE = 'zhongwen';

export type ZhongwenDaemonOptions = {
	getToken?: () => Promise<string | null>;
	peer?: PeerDescriptor;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultZhongwenDaemonPeer(): PeerDescriptor {
	return {
		id: 'zhongwen-daemon',
		name: 'Zhongwen Daemon',
		platform: 'node',
	};
}

export function zhongwenDaemon({
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultZhongwenDaemonPeer(),
	webSocketImpl,
}: ZhongwenDaemonOptions = {}) {
	return ({ projectDir }: EpicenterConfigContext) => {
		const doc = openZhongwenDoc({ clientID: hashClientId(projectDir) });
		const yjsLog = attachYjsLog(doc.ydoc, {
			filePath: yjsPath(projectDir, doc.ydoc.guid),
		});
		const sync = attachSync(doc, {
			url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
			getToken,
			webSocketImpl,
		});
		const presence = sync.attachPresence({ peer });
		const actions = {};
		const rpc = sync.attachRpc(actions);

		return {
			...doc,
			yjsLog,
			sync,
			presence,
			rpc,
			actions,
		};
	};
}
