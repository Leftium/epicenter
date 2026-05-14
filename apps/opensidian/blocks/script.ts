import { createMachineAuthClient, requireSession } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	type ProjectDir,
	roomWsUrl,
} from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import * as Y from 'yjs';
import { OPENSIDIAN_WORKSPACE_ID, opensidianTables } from './workspace.js';

export async function openOpensidianScript({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
}: {
	projectDir?: ProjectDir;
	clientID?: number;
}) {
	const auth = await createMachineAuthClient();
	const session = requireSession(auth);
	const ydoc = new Y.Doc({ guid: OPENSIDIAN_WORKSPACE_ID, gc: false });
	ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc, {
		encryptionKeys: () => session.encryptionKeys,
	});
	const tables = encryption.attachTables(opensidianTables);
	const kv = encryption.attachKv({});
	const yjsLog = attachYjsLogReader(ydoc, {
		filePath: yjsPath(projectDir, ydoc.guid),
	});
	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl(EPICENTER_API_URL, ydoc.guid),
		openWebSocket: session.openWebSocket,
		replicaId: 'opensidian-script',
		actions: {},
	});

	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		yjsLog,
		collaboration,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type OpensidianScript = Awaited<ReturnType<typeof openOpensidianScript>>;
