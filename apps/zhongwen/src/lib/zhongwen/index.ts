import { attachEncryption, type EncryptionKeys } from '@epicenter/workspace';
import * as Y from 'yjs';
import { zhongwenKv, zhongwenTables } from '../workspace/index.js';

export function openZhongwen({
	encryptionKeys,
	clientID,
}: {
	encryptionKeys?: EncryptionKeys;
	clientID?: number;
} = {}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(zhongwenTables);
	const kv = encryption.attachKv(zhongwenKv);
	if (encryptionKeys !== undefined) {
		encryption.applyKeys(encryptionKeys);
	}
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
