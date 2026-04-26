import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { getOrCreateDeviceId } from '@epicenter/workspace';
import { openFuji } from './browser';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export const fuji = openFuji({
	auth,
	device: {
		id: getOrCreateDeviceId(localStorage),
		name: 'Fuji',
		platform: 'web',
	},
});

auth.onSessionChange((next, previous) => {
	if (next === null) {
		fuji.sync.goOffline();
		if (previous !== null) void fuji.idb.clearLocal();
		return;
	}
	fuji.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) fuji.sync.reconnect();
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
