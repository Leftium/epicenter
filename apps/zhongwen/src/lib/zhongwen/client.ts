import { createAuth, createSessionStorageAdapter } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { session } from '$lib/auth';
import { openZhongwen } from './browser';

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

export const zhongwen = openZhongwen();

auth.subscribe((next, previous) => {
	if (next.status === 'loading') return;

	const previousSession =
		previous.status === 'signedIn' ? previous.session : null;

	if (next.status === 'signedOut') {
		if (previousSession !== null) void zhongwen.idb.clearLocal();
		return;
	}
	zhongwen.encryption.applyKeys(next.session.encryptionKeys);
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
