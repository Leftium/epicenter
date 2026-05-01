import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { createMachineTokenGetter } from '@epicenter/auth/node';
import {
	attachAwareness,
	attachSync,
	createRemoteClient,
	PeerIdentity,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import {
	attachMarkdown,
	slugFilename,
} from '@epicenter/workspace/document/attach-markdown';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import {
	attachYjsLog,
	connectDaemonActions,
	hashClientId,
	markdownPath,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import type { createFujiActions } from '../workspace.js';
import { openFuji as openFujiDoc } from './index.js';

export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';

export type FujiDaemonOptions = {
	route?: string;
	getToken?: () => Promise<string | null>;
	peer?: PeerIdentity;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultFujiDaemonPeer(): PeerIdentity {
	return {
		id: 'fuji-daemon',
		name: 'Fuji Daemon',
		platform: 'node',
	};
}

export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createMachineTokenGetter({ serverOrigin: apiUrl }),
	peer = defaultFujiDaemonPeer(),
	webSocketImpl,
}: FujiDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		start({ projectDir }) {
			const doc = openFujiDoc({ clientID: hashClientId(projectDir) });
			attachYjsLog(doc.ydoc, {
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
			const rpc = sync.attachRpc(doc.actions);
			const remote = createRemoteClient({ awareness, rpc });
			attachSqlite(doc.ydoc, {
				filePath: sqlitePath(projectDir, doc.ydoc.guid),
			}).table(doc.tables.entries);
			attachMarkdown(doc.ydoc, {
				dir: markdownPath(projectDir, doc.ydoc.guid),
			}).table(doc.tables.entries, { filename: slugFilename('title') });

			return {
				actions: doc.actions,
				awareness,
				sync,
				remote,
				rpc,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await sync.whenDisposed;
				},
			};
		},
	};
}

export function connectFujiDaemonActions({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	projectDir,
}: {
	route?: string;
	projectDir?: ProjectDir;
} = {}) {
	return connectDaemonActions<ReturnType<typeof createFujiActions>>({
		route,
		projectDir,
	});
}
