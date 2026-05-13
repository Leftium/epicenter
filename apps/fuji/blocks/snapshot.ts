import { loadMachineSession } from '@epicenter/auth/node';
import type { EncryptionKeys } from '@epicenter/encryption';
import { FUJI_WORKSPACE_ID, fujiTables } from '@epicenter/fuji';
import { attachEncryption, type ProjectDir } from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import * as Y from 'yjs';

export type OpenFujiSnapshotOptions = {
	projectDir?: ProjectDir;
	clientID?: number;
	loadOfflineEncryptionKeys?: () => Promise<EncryptionKeys | null>;
};

async function loadMachineOfflineEncryptionKeys(): Promise<EncryptionKeys | null> {
	const { data: session, error } = await loadMachineSession();
	if (error) throw error;
	return session?.encryptionKeys ?? null;
}

export async function openFujiSnapshot({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	loadOfflineEncryptionKeys = loadMachineOfflineEncryptionKeys,
}: OpenFujiSnapshotOptions = {}) {
	const offlineEncryptionKeys = await loadOfflineEncryptionKeys();
	if (offlineEncryptionKeys === null) {
		throw new Error(
			'[fuji] cannot open snapshot: no machine encryption keys. Run `epicenter login` on this machine.',
		);
	}
	const ydoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
	ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc, {
		encryptionKeys: () => offlineEncryptionKeys,
	});
	const tables = encryption.attachTables(fujiTables);
	encryption.attachKv({});
	const yjsLog = attachYjsLogReader(ydoc, {
		filePath: yjsPath(projectDir, ydoc.guid),
	});

	return {
		tables,
		yjsLog,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type FujiSnapshot = Awaited<ReturnType<typeof openFujiSnapshot>>;
