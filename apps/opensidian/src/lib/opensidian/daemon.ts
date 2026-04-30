import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	attachYjsLog,
	findEpicenterDir,
	hashClientId,
	type PeerDescriptor,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
	yjsPath,
} from '@epicenter/workspace';
import { openOpensidian as openOpensidianDoc } from './index.js';

export function openOpensidian({
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
	const doc = openOpensidianDoc({ clientID });
	const yjsLog = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});

	const actions = {};
	const presence = sync.attachPresence({ peer });
	const rpc = sync.attachRpc({ actions: { actions } });

	return { ...doc, yjsLog, sync, actions, presence, rpc };
}
