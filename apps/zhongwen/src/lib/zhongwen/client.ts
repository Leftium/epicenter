import { createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { session } from '$lib/auth';
import { openZhongwen } from './browser';

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export const zhongwen = openZhongwen();

auth.onSessionChange((next, previous) => {
	if (next === null) {
		if (previous !== null) void zhongwen.idb.clearLocal();
		return;
	}
	zhongwen.encryption.applyKeys(next.encryptionKeys);
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
