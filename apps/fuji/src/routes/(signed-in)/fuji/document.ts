import { attachEncryption, type EncryptionKeys } from '@epicenter/workspace';
import * as Y from 'yjs';
import { fujiTables } from './workspace.js';

export const FUJI_WORKSPACE_ID = 'epicenter.fuji';

export function openFujiDocument({
	encryptionKeys,
	clientID,
}: {
	encryptionKeys: () => EncryptionKeys;
	clientID?: number;
}) {
	const ydoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc, { encryptionKeys });
	const tables = encryption.attachTables(fujiTables);
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
