import {
	createAuth,
	createSessionStorageAdapter,
} from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { session } from '$lib/auth';
import { openZhongwen } from './browser';

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

export const zhongwen = openZhongwen();

let activeUserId: string | null = null;

function applyAuthSnapshot(snapshot: typeof auth.snapshot) {
	if (snapshot.status === 'loading') return;

	if (snapshot.status === 'signedOut') {
		if (activeUserId !== null) {
			activeUserId = null;
			void zhongwen.idb.clearLocal();
		}
		return;
	}

	if (activeUserId !== snapshot.session.user.id && activeUserId !== null) {
		activeUserId = null;
		void zhongwen.idb.clearLocal().then(() => applyAuthSnapshot(snapshot));
		return;
	}

	zhongwen.encryption.applyKeys(snapshot.session.encryptionKeys);
	activeUserId = snapshot.session.user.id;
}

// Zhongwen has encrypted local persistence but no auth-backed sync target, so
// it keeps a small local listener instead of using bindWorkspaceAuthLifecycle.
applyAuthSnapshot(auth.snapshot);
auth.onSnapshotChange(applyAuthSnapshot);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
