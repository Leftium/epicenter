import { createMachineAuth } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import type { EncryptionKeys } from '@epicenter/encryption';
import { attachEncryption, type ProjectDir } from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import * as Y from 'yjs';
import { fujiTables } from '../workspace.js';
import {
	connectFujiDaemonActions,
	DEFAULT_FUJI_DAEMON_ROUTE,
} from './daemon.js';
import { FUJI_WORKSPACE_ID } from './index.js';

type LoadOfflineEncryptionKeys = () => Promise<EncryptionKeys | null>;

export type OpenFujiSnapshotOptions = {
	projectDir?: ProjectDir;
	clientID?: number;
	loadOfflineEncryptionKeys?: LoadOfflineEncryptionKeys;
};

async function loadMachineOfflineEncryptionKeys(): Promise<EncryptionKeys | null> {
	const { data, error } = await createMachineAuth().getOfflineEncryptionKeys({
		serverOrigin: EPICENTER_API_URL,
	});
	if (error) throw error;
	return data;
}

export async function openFujiSnapshot({
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	loadOfflineEncryptionKeys = loadMachineOfflineEncryptionKeys,
}: OpenFujiSnapshotOptions = {}) {
	const encryptionKeys = await loadOfflineEncryptionKeys();
	const ydoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
	ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachReadonlyTables(ydoc, fujiTables);
	if (encryptionKeys !== null) encryption.applyKeys(encryptionKeys);
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

export async function openFujiScript({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	projectDir = findEpicenterDir(),
	clientID,
	loadOfflineEncryptionKeys,
}: OpenFujiSnapshotOptions & { route?: string } = {}) {
	const snapshotAttachment = await openFujiSnapshot({
		projectDir,
		clientID,
		loadOfflineEncryptionKeys,
	});
	const actions = await connectFujiDaemonActions({ route, projectDir });

	return {
		snapshot: snapshotAttachment.tables,
		actions,
		async [Symbol.asyncDispose]() {
			snapshotAttachment[Symbol.dispose]();
			await snapshotAttachment.yjsLog.whenDisposed;
		},
	};
}
