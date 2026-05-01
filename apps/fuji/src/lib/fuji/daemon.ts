import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerDescriptor,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import type { EpicenterConfigContext } from '@epicenter/workspace/daemon';
import {
	attachMarkdown,
	slugFilename,
} from '@epicenter/workspace/document/attach-markdown';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import {
	attachYjsLog,
	connectDaemonActions,
	createSessionTokenGetter,
	hashClientId,
	markdownPath,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import type { createFujiActions } from '../workspace.js';
import { openFuji as openFujiDoc } from './index.js';

export const FUJI_DAEMON_ROUTE = 'fuji';

export type FujiDaemonOptions = {
	getToken?: () => Promise<string | null>;
	peer?: PeerDescriptor;
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

export function fujiDaemon({
	apiUrl = EPICENTER_API_URL,
	getToken = createSessionTokenGetter({ serverUrl: apiUrl }),
	peer = defaultFujiDaemonPeer(),
	webSocketImpl,
}: FujiDaemonOptions = {}) {
	return ({ projectDir }: EpicenterConfigContext) => {
		const doc = openFujiDoc({ clientID: hashClientId(projectDir) });
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
			actions: doc.actions,
			sync,
			presence,
			rpc,
			[Symbol.dispose]() {
				doc[Symbol.dispose]();
			},
		};
	};
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
