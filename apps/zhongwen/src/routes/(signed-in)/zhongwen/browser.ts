import {
	attachOwnedBroadcastChannel,
	type EncryptionKeys,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { openZhongwenDocument } from './document.js';

export function openZhongwenBrowser({
	userId,
	encryptionKeys,
}: {
	userId: string;
	encryptionKeys: () => EncryptionKeys;
}) {
	const doc = openZhongwenDocument({ encryptionKeys });
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

export type ZhongwenBrowser = ReturnType<typeof openZhongwenBrowser>;
