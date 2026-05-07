import {
	attachOwnedBroadcastChannel,
	type EncryptionKeys,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen({
	userId,
	encryptionKeys,
}: {
	userId: string;
	encryptionKeys: () => EncryptionKeys;
}) {
	const doc = openZhongwenDoc({ getKeys: encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	return {
		...doc,
		idb,
		async wipe() {
			doc[Symbol.dispose]();
			await idb.whenDisposed;
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}

export type Zhongwen = ReturnType<typeof openZhongwen>;
