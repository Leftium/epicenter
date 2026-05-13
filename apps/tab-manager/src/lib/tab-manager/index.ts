import { attachEncryption, type EncryptionKeys } from '@epicenter/workspace';
import * as Y from 'yjs';
import { tabManagerTables } from '$lib/workspace/definition';

export function openTabManagerDoc({
	encryptionKeys,
}: {
	encryptionKeys: () => EncryptionKeys;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager', gc: false });
	const encryption = attachEncryption(ydoc, { encryptionKeys });
	const tables = encryption.attachTables(tabManagerTables);
	const kv = encryption.attachKv({});
	const batch = (fn: () => void) => ydoc.transact(fn);
	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
