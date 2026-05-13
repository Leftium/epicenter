import { attachEncryption, type EncryptionKeys } from '@epicenter/workspace';
import * as Y from 'yjs';
import { honeycrispTables } from './workspace.js';

export function openHoneycrispDocument({
	encryptionKeys,
	clientID,
}: {
	encryptionKeys: () => EncryptionKeys;
	clientID?: number;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.honeycrisp', gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc, { encryptionKeys });
	const tables = encryption.attachTables(honeycrispTables);
	const kv = encryption.attachKv({});
	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type HoneycrispDocument = ReturnType<typeof openHoneycrispDocument>;
