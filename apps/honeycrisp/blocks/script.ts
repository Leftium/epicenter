import { createMachineAuthClient, requireIdentity } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
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
import * as Y from 'yjs';
import { honeycrispTables } from '@epicenter/honeycrisp';

export async function openHoneycrispScript({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
}: {
	projectDir?: ProjectDir;
	clientID?: number;
}) {
	const auth = await createMachineAuthClient();
	const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
	ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc, {
		encryptionKeys: () => requireIdentity(auth).encryptionKeys,
	});
	const tables = encryption.attachTables(honeycrispTables);
	const kv = encryption.attachKv({});
	const yjsLog = attachYjsLogReader(ydoc, {
		filePath: yjsPath(projectDir, ydoc.guid),
	});
	const sync = attachYjsSync(ydoc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${ydoc.guid}`),
		openWebSocket: auth.openWebSocket,
	});

	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		yjsLog,
		sync,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type HoneycrispScript = Awaited<ReturnType<typeof openHoneycrispScript>>;
