import type { AuthIdentity } from '@epicenter/auth';
import {
	attachOwnedBroadcastChannel,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen({ identity }: { identity: AuthIdentity }) {
	const userId = identity.user.id;
	const doc = openZhongwenDoc({ encryptionKeys: identity.encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });
	const dispose = () => doc[Symbol.dispose]();

	return {
		...doc,
		whenLoaded: idb.whenLoaded,
		whenReady: idb.whenLoaded,
		dispose,
		async wipe() {
			dispose();
			await idb.whenDisposed;
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
		[Symbol.dispose]: dispose,
	};
}

export type Zhongwen = ReturnType<typeof openZhongwen>;
