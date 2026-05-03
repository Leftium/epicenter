import type { AuthClient } from '@epicenter/auth';
import { createMachineAuthClient } from '@epicenter/auth/node';
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

export async function openHoneycrisp({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	auth,
	webSocketImpl,
}: {
	projectDir?: ProjectDir;
	clientID?: number;
	auth?: AuthClient;
	webSocketImpl?: WebSocketImpl;
}) {
	const syncAuth = auth ?? (await createMachineAuthClient());
	const doc = openHoneycrispDoc({ clientID });
	const yjsLog = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		auth: syncAuth,
		webSocketImpl,
	});
	const rpc = sync.attachRpc(doc.actions);

	return { ...doc, yjsLog, sync, rpc };
}
