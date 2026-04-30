import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerDescriptor,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import {
	type DaemonHostDefinition,
	defineDaemon,
	type HostedWorkspace,
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

export type OpenHoneycrispDaemonOptions = {
	projectDir: ProjectDir;
	route?: string;
	getToken: () => string | null | Promise<string | null>;
	peer?: PeerDescriptor;
	clientID?: number;
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
}: DefineHoneycrispDaemonOptions = {}): DaemonHostDefinition {
	return defineDaemon({
		route,
		title: 'Honeycrisp',
		description: 'Honeycrisp daemon workspace',
		workspaceId: HONEYCRISP_WORKSPACE_ID,
		open: ({ projectDir }) =>
			openHoneycrispDaemon({
				route,
				projectDir,
				getToken,
				peer,
				apiUrl,
				webSocketImpl,
			}),
	});
}

export function openHoneycrispDaemon({
	route = HONEYCRISP_DAEMON_ROUTE,
	projectDir,
	apiUrl = EPICENTER_API_URL,
	getToken,
	peer = defaultHoneycrispDaemonPeer(),
	clientID = hashClientId(projectDir),
	webSocketImpl,
}: OpenHoneycrispDaemonOptions) {
	const doc = openHoneycrispDoc({ clientID });
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
		route,
		yjsLog,
		sync,
		presence,
		rpc,
	} satisfies HostedWorkspace;
}
