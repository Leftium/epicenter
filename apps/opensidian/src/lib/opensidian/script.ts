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
import { openOpensidian as openOpensidianDoc } from './index.js';

export async function openOpensidian({
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
	const doc = openOpensidianDoc({ clientID });
	const yjsLog = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		auth: syncAuth,
		webSocketImpl,
	});

	return { ...doc, yjsLog, sync };
}
