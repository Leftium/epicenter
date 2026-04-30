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
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export const HONEYCRISP_DAEMON_ROUTE = 'honeycrisp';
export const HONEYCRISP_WORKSPACE_ID = 'epicenter.honeycrisp';

export type DefineHoneycrispDaemonOptions = {
	route?: string;
	getToken?: () => string | null | Promise<string | null>;
	peer?: PeerDescriptor;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultHoneycrispDaemonPeer(): PeerDescriptor {
	return {
		id: 'honeycrisp-daemon',
		name: 'Honeycrisp Daemon',
		platform: 'node',
	};
}

export function defineHoneycrispDaemon({
	route = HONEYCRISP_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultHoneycrispDaemonPeer(),
	webSocketImpl,
}: DefineHoneycrispDaemonOptions = {}) {
	return defineDaemon({
		route,
		title: 'Honeycrisp',
		description: 'Honeycrisp daemon workspace',
		workspaceId: HONEYCRISP_WORKSPACE_ID,
		start: ({ projectDir }) => {
			const doc = openHoneycrispDoc({ clientID: hashClientId(projectDir) });
			const yjsLog = attachYjsLog(doc.ydoc, {
				filePath: yjsPath(projectDir, doc.ydoc.guid),
			});
			const sync = attachSync(doc, {
				url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
				getToken,
				webSocketImpl,
			});
			const presence = sync.attachPresence({ peer });
			const rpc = sync.attachRpc(doc.actions);

			return {
				...doc,
				yjsLog,
				sync,
				presence,
				rpc,
			} satisfies DaemonWorkspace;
		},
	});
}
