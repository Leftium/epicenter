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
import { openOpensidian as openOpensidianDoc } from './index.js';

export const OPENSIDIAN_DAEMON_ROUTE = 'opensidian';
export const OPENSIDIAN_WORKSPACE_ID = 'epicenter.opensidian';

export type DefineOpensidianDaemonOptions = {
	route?: string;
	getToken?: () => string | null | Promise<string | null>;
	peer?: PeerDescriptor;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultOpensidianDaemonPeer(): PeerDescriptor {
	return {
		id: 'opensidian-daemon',
		name: 'Opensidian Daemon',
		platform: 'node',
	};
}

export function defineOpensidianDaemon({
	route = OPENSIDIAN_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultOpensidianDaemonPeer(),
	webSocketImpl,
}: DefineOpensidianDaemonOptions = {}) {
	return defineDaemon({
		route,
		title: 'Opensidian',
		description: 'Opensidian daemon workspace',
		workspaceId: OPENSIDIAN_WORKSPACE_ID,
		start: ({ projectDir }) => {
			const doc = openOpensidianDoc({ clientID: hashClientId(projectDir) });
			const yjsLog = attachYjsLog(doc.ydoc, {
				filePath: yjsPath(projectDir, doc.ydoc.guid),
			});
			const sync = attachSync(doc, {
				url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
				getToken,
				webSocketImpl,
			});

			// Daemon runtime is materializer-only for now. Browser runtime owns
			// Opensidian file and shell actions because they need browser services.
			const actions = {};
			const presence = sync.attachPresence({ peer });
			const rpc = sync.attachRpc(actions);

			return {
				...doc,
				yjsLog,
				sync,
				actions,
				presence,
				rpc,
			} satisfies DaemonWorkspace;
		},
	});
}
