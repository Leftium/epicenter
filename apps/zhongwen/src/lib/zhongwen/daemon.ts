import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerDescriptor,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import {
	type DaemonWorkspace,
	defineDaemon,
} from '@epicenter/workspace/daemon';
import {
	attachYjsLog,
	createSessionTokenGetter,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openZhongwen as openZhongwenDoc } from './index.js';

export const ZHONGWEN_DAEMON_ROUTE = 'zhongwen';
export const ZHONGWEN_WORKSPACE_ID = 'epicenter.zhongwen';

export type DefineZhongwenDaemonOptions = {
	route?: string;
	getToken?: () => string | null | Promise<string | null>;
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

export function defineZhongwenDaemon({
	route = ZHONGWEN_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultZhongwenDaemonPeer(),
	webSocketImpl,
}: DefineZhongwenDaemonOptions = {}) {
	return defineDaemon({
		route,
		title: 'Zhongwen',
		description: 'Zhongwen daemon workspace',
		workspaceId: ZHONGWEN_WORKSPACE_ID,
		start: ({ projectDir }) => {
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

			return {
				...doc,
				yjsLog,
				sync,
				presence,
				actions: {},
			} satisfies DaemonWorkspace;
		},
	});
}
