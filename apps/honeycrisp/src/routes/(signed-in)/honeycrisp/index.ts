import { attachEncryption, type EncryptionKeys } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createHoneycrispActions, honeycrispTables } from './workspace.js';

export function openHoneycrisp({
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
	const actions = createHoneycrispActions(tables);
	return {
		ydoc,
		tables,
		kv,
		encryption,
		actions,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
