import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerDescriptor,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import {
	defineDaemon,
	type DaemonHostDefinition,
	type HostedWorkspace,
} from '@epicenter/workspace/daemon';
import {
	connectDaemonActions,
	attachYjsLog,
	createSessionTokenGetter,
	hashClientId,
	markdownPath,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import {
	attachMarkdown,
	slugFilename,
} from '@epicenter/workspace/document/attach-markdown';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import type { createFujiActions } from '../workspace.js';
import { openFuji as openFujiDoc } from './index.js';

export const FUJI_DAEMON_ROUTE = 'fuji';
export const FUJI_WORKSPACE_ID = 'epicenter.fuji';

export type DefineFujiDaemonOptions = {
	route?: string;
	getToken?: () => string | null | Promise<string | null>;
	peer?: PeerDescriptor;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

export type OpenFujiDaemonOptions = {
	projectDir: ProjectDir;
	route?: string;
	getToken: () => string | null | Promise<string | null>;
	peer?: PeerDescriptor;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

function defaultFujiDaemonPeer(): PeerDescriptor {
	return {
		id: 'fuji-daemon',
		name: 'Fuji Daemon',
		platform: 'node',
	};
}

export function defineFujiDaemon({
	route = FUJI_DAEMON_ROUTE,
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultFujiDaemonPeer(),
	webSocketImpl,
}: DefineFujiDaemonOptions = {}): DaemonHostDefinition {
	return defineDaemon({
		route,
		title: 'Fuji',
		description: 'Fuji daemon workspace',
		workspaceId: FUJI_WORKSPACE_ID,
		open: ({ projectDir }) =>
			openFujiDaemon({
				route,
				projectDir,
				getToken,
				peer,
				apiUrl,
				webSocketImpl,
			}),
	});
}

export function openFujiDaemon({
	route = FUJI_DAEMON_ROUTE,
	projectDir,
	apiUrl = EPICENTER_API_URL,
	getToken,
	peer = defaultFujiDaemonPeer(),
	clientID = hashClientId(projectDir),
	webSocketImpl,
}: OpenFujiDaemonOptions) {
	const doc = openFujiDoc({ clientID });
	attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});
	const presence = sync.attachPresence({ peer });
	const rpc = sync.attachRpc(doc.actions);
	attachSqlite(doc.ydoc, {
		filePath: sqlitePath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries);
	attachMarkdown(doc.ydoc, {
		dir: markdownPath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries, { filename: slugFilename('title') });

	return {
		route,
		actions: doc.actions,
		sync,
		presence,
		rpc,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	} satisfies HostedWorkspace;
}

export function openFujiDaemonActions({
	route = FUJI_DAEMON_ROUTE,
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
