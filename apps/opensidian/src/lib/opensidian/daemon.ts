import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerIdentityInput,
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
import { openOpensidian as openOpensidianDoc } from './index.js';

export const OPENSIDIAN_DAEMON_ROUTE = 'opensidian';

export type OpensidianDaemonOptions = {
	getToken?: () => Promise<string | null>;
	peer?: PeerIdentityInput;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultOpensidianDaemonPeer(): PeerIdentityInput {
	return {
		id: 'opensidian-daemon',
		name: 'Opensidian Daemon',
		platform: 'node',
	};
}

export function opensidianDaemon({
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultOpensidianDaemonPeer(),
	webSocketImpl,
}: OpensidianDaemonOptions = {}) {
	return ({ projectDir }: EpicenterConfigContext) => {
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
		};
	};
}
