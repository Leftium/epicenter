import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	type PeerDescriptor,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
} from '@epicenter/workspace';
import {
	attachYjsLog,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openZhongwen as openZhongwenDoc } from './index.js';

export function openZhongwen({
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
	const doc = openZhongwenDoc({ clientID });
	const yjsLog = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});
	const presence = sync.attachPresence({ peer });

	return { ...doc, yjsLog, sync, presence };
}
