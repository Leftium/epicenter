import type { AuthClient } from '@epicenter/auth';
import { createMachineAuthClient } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
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
import { openOpensidian as openOpensidianDoc } from './index.js';

export const DEFAULT_OPENSIDIAN_DAEMON_ROUTE = 'opensidian';

export type OpensidianDaemonOptions = {
	route?: string;
	auth?: AuthClient;
	peer?: PeerIdentity;
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
	auth = createMachineAuthClient(),
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
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
				auth,
				webSocketImpl,
				awareness,
			});

			// Daemon runtime is materializer-only for now. Browser runtime owns
			// Opensidian file and shell actions because they need browser services.
			const actions = {};
			const rpc = sync.attachRpc(actions);
			const remote = createRemoteClient({ awareness, rpc });

			return {
				...doc,
				yjsLog,
				awareness,
				sync,
				actions,
				remote,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await sync.whenDisposed;
				},
			};
		},
	};
}
