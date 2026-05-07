import { attachEncryption, type EncryptionKeys } from '@epicenter/workspace';
import * as Y from 'yjs';
import { opensidianTables } from '../workspace/definition.js';

export function openOpensidian({
	encryptionKeys,
	clientID,
}: {
	encryptionKeys: () => EncryptionKeys;
	clientID?: number;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.opensidian', gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc, { encryptionKeys });
	const tables = encryption.attachTables(opensidianTables);
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
