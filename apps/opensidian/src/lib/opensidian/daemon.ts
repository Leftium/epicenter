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
import { openOpensidian as openOpensidianDoc } from './index.js';

export const DEFAULT_OPENSIDIAN_DAEMON_ROUTE = 'opensidian';

export type OpensidianDaemonOptions = {
	route?: string;
	getToken?: () => Promise<string | null>;
	peer?: PeerIdentity;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultOpensidianDaemonPeer(): PeerIdentity {
	return {
		id: 'opensidian-daemon',
		name: 'Opensidian Daemon',
		platform: 'node',
	};
}

export function defineOpensidianDaemon({
	route = DEFAULT_OPENSIDIAN_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createCredentialTokenGetter({ serverOrigin: apiUrl }),
	peer = defaultOpensidianDaemonPeer(),
	webSocketImpl,
}: OpensidianDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		start({ projectDir }) {
			const doc = openOpensidianDoc({ clientID: hashClientId(projectDir) });
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

			// Daemon runtime is materializer-only for now. Browser runtime owns
			// Opensidian file and shell actions because they need browser services.
			const actions = {};
			const peerDirectory = createPeerDirectory({ awareness, sync });
			const rpc = sync.attachRpc(actions);

			return {
				...doc,
				yjsLog,
				awareness,
				sync,
				actions,
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
