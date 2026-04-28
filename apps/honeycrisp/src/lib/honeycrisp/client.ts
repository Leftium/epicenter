import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { getOrCreateDeviceId } from '@epicenter/workspace';
import { openHoneycrisp } from './browser';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export const honeycrisp = openHoneycrisp({
	auth,
	device: {
		id: getOrCreateDeviceId(localStorage),
		name: 'Honeycrisp',
		platform: 'web',
	},
});

auth.onSessionChange((next, previous) => {
	if (next === null) {
		honeycrisp.sync.goOffline();
		if (previous !== null) void honeycrisp.idb.clearLocal();
		return;
	}
	honeycrisp.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) honeycrisp.sync.reconnect();
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
