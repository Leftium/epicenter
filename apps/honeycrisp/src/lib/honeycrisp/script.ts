import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export function openHoneycrisp({
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
	const doc = openHoneycrispDoc({ clientID });
	const yjsLog = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});
	const rpc = sync.attachRpc({ actions: { actions: doc.actions } });

	return { ...doc, yjsLog, sync, rpc };
}
