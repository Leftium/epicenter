import { attachEncryption, type EncryptionKeys } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFujiActions, fujiTables } from './workspace.js';

export const FUJI_WORKSPACE_ID = 'epicenter.fuji';

export function openFuji({
	getKeys,
	clientID,
}: {
	getKeys: () => EncryptionKeys;
	clientID?: number;
}) {
	const ydoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc, { getKeys });
	const tables = encryption.attachTables(fujiTables);
	const kv = encryption.attachKv({});
	const actions = createFujiActions(tables);
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
