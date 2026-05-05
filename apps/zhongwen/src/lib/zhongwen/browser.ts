import type { AuthClient } from '@epicenter/auth';
import {
	attachOwnedBroadcastChannel,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen({ auth }: { auth: AuthClient }) {
	const identity = auth.identity;
	if (identity === null) {
		throw new Error(
			'openZhongwen requires signed-in auth.identity. Await auth.whenReady first.',
		);
	}
	const userId = identity.user.id;
	const doc = openZhongwenDoc({ encryptionKeys: identity.encryptionKeys });
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
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}
