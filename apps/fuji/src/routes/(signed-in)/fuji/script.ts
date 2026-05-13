import { loadMachineSession } from '@epicenter/auth/node';
import type { EncryptionKeys } from '@epicenter/encryption';
import type { ProjectDir } from '@epicenter/workspace';
import {
	attachYjsLogReader,
	findEpicenterDir,
	hashClientId,
	yjsPath,
} from '@epicenter/workspace/node';
import {
	connectFujiDaemonActions,
	DEFAULT_FUJI_DAEMON_ROUTE,
} from './daemon.js';
import { openFujiDocument } from './document.js';

type LoadOfflineEncryptionKeys = () => Promise<EncryptionKeys | null>;

export type OpenFujiSnapshotOptions = {
	projectDir?: ProjectDir;
	clientID?: number;
	loadOfflineEncryptionKeys?: LoadOfflineEncryptionKeys;
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
	const doc = openFujiDocument({
		clientID,
		encryptionKeys: () => offlineEncryptionKeys,
	});
	const yjsLog = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	return {
		tables: doc.tables,
		yjsLog,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
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
		},
	};
}

export type FujiScript = Awaited<ReturnType<typeof openFujiScript>>;
