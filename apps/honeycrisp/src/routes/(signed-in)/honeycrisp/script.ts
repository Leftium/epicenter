import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachYjsSync,
	type ProjectDir,
	toWsUrl,
} from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import { openHoneycrispDocument } from './document.js';

export async function openHoneycrispScript({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
}: {
	projectDir?: ProjectDir;
	clientID?: number;
}) {
	const auth = await createMachineAuthClient();
	const doc = openHoneycrispDocument({
		clientID,
		encryptionKeys: () => requireIdentity(auth).encryptionKeys,
	});
	const yjsLog = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachYjsSync(doc.ydoc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		openWebSocket: auth.openWebSocket,
	});

	return {
		ydoc: doc.ydoc,
		tables: doc.tables,
		kv: doc.kv,
		encryption: doc.encryption,
		batch: doc.batch,
		yjsLog,
		sync,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}

export type HoneycrispScript = Awaited<ReturnType<typeof openHoneycrispScript>>;
