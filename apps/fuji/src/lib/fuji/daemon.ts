import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	attachYjsLog,
	findEpicenterDir,
	hashClientId,
	markdownPath,
	type PeerDescriptor,
	type ProjectDir,
	sqlitePath,
	toWsUrl,
	type WebSocketImpl,
	yjsPath,
} from '@epicenter/workspace';
import {
	attachMarkdown,
	slugFilename,
} from '@epicenter/workspace/document/attach-markdown';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import { openFuji as openFujiDoc } from './index.js';

export function openFuji({
	getToken,
	peer,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(projectDir),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => Promise<string | null>;
	peer: PeerDescriptor;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc({ clientID });
	const yjsLog = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});
	const presence = sync.attachPresence({ peer });
	const rpc = sync.attachRpc({ actions: { actions: doc.actions } });
	const sqlite = attachSqlite(doc.ydoc, {
		filePath: sqlitePath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries);
	const markdown = attachMarkdown(doc.ydoc, {
		dir: markdownPath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries, { filename: slugFilename('title') });

	return { ...doc, yjsLog, sync, presence, rpc, sqlite, markdown };
}
