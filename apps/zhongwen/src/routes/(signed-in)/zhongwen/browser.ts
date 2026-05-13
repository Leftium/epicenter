import {
	attachEncryption,
	attachOwnedBroadcastChannel,
	type EncryptionKeys,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { zhongwenKv, zhongwenTables } from '@epicenter/zhongwen';

export function openZhongwenBrowser({
	userId,
	encryptionKeys,
}: {
	userId: string;
	encryptionKeys: () => EncryptionKeys;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.zhongwen', gc: false });
	const encryption = attachEncryption(ydoc, { encryptionKeys });
	const tables = encryption.attachTables(zhongwenTables);
	const kv = encryption.attachKv(zhongwenKv);
	const idb = encryption.attachIndexedDb(ydoc, { userId });
	attachOwnedBroadcastChannel(ydoc, { userId });

	return {
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		idb,
		async wipe() {
			ydoc.destroy();
			await idb.whenDisposed;
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [ydoc.guid],
			});
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type ZhongwenBrowser = ReturnType<typeof openZhongwenBrowser>;
