import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSync,
	attachYjsLog,
	type DeviceDescriptor,
	findEpicenterDir,
	hashClientId,
	type ProjectDir,
	toWsUrl,
	type WebSocketImpl,
	yjsPath,
} from '@epicenter/workspace';
import { openOpensidian as openOpensidianDoc } from './index.js';

export function openOpensidian({
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
	const doc = openOpensidianDoc({ clientID });
	const persistence = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		device,
		getToken,
		webSocketImpl,
	});

	return { ...doc, persistence, sync };
}
