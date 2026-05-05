import type { AuthIdentity } from '@epicenter/auth';
import {
	attachOwnedBroadcastChannel,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { createContext } from 'svelte';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen({ identity }: { identity: AuthIdentity }) {
	const userId = identity.user.id;
	const doc = openZhongwenDoc({ encryptionKeys: identity.encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	return {
		...doc,
		whenLoaded: idb.whenLoaded,
		async wipe() {
			doc[Symbol.dispose]();
			await idb.whenDisposed;
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
	};
}

export type Zhongwen = ReturnType<typeof openZhongwen>;
export const [getZhongwen, setZhongwen] = createContext<Zhongwen>();
