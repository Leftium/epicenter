import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { createCredentialTokenGetter } from '@epicenter/auth/node';
import {
	attachAwareness,
	attachSync,
	createPeerDirectory,
	PeerIdentity,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import {
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export const DEFAULT_HONEYCRISP_DAEMON_ROUTE = 'honeycrisp';

export type HoneycrispDaemonOptions = {
	route?: string;
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

export function defineHoneycrispDaemon({
	route = DEFAULT_HONEYCRISP_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createCredentialTokenGetter({ serverOrigin: apiUrl }),
	peer = defaultHoneycrispDaemonPeer(),
	webSocketImpl,
}: HoneycrispDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		start({ projectDir }) {
			const doc = openHoneycrispDoc({ clientID: hashClientId(projectDir) });
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
			const peerDirectory = createPeerDirectory({ awareness, sync });
			const rpc = sync.attachRpc(doc.actions);

			return {
				...doc,
				yjsLog,
				awareness,
				sync,
				peerDirectory,
				rpc,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await sync.whenDisposed;
				},
			};
		},
	};
}
