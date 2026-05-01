import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerIdentity,
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
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export const HONEYCRISP_DAEMON_ROUTE = 'honeycrisp';

export type HoneycrispDaemonOptions = {
	getToken?: () => Promise<string | null>;
	peer?: PeerIdentity;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultHoneycrispDaemonPeer(): PeerIdentity {
	return {
		id: 'honeycrisp-daemon',
		name: 'Honeycrisp Daemon',
		platform: 'node',
	};
}

export function honeycrispDaemon({
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultHoneycrispDaemonPeer(),
	webSocketImpl,
}: HoneycrispDaemonOptions = {}) {
	return ({ projectDir }: EpicenterConfigContext) => {
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
		};
	};
}
