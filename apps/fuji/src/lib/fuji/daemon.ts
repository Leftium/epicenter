import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	attachYjsLog,
	type DeviceDescriptor,
	findEpicenterDir,
	hashClientId,
	markdownPath,
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
	device,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(projectDir),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => Promise<string | null>;
	device: DeviceDescriptor;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc({ clientID });
	const persistence = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		device,
		getToken,
		webSocketImpl,
	});
	const sqlite = attachSqlite(doc.ydoc, {
		filePath: sqlitePath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries);
	const markdown = attachMarkdown(doc.ydoc, {
		dir: markdownPath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries, { filename: slugFilename('title') });

	return { ...doc, persistence, sync, sqlite, markdown };
}
