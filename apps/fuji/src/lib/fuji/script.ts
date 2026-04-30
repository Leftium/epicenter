import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
	yjsPath,
} from '@epicenter/workspace';
import { openFuji as openFujiDoc } from './index.js';

export function openFuji({
	getToken,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => Promise<string | null>;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc({ clientID });
	const persistence = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});

	return { ...doc, persistence, sync };
}
