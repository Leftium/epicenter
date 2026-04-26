import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { actionManifest } from '@epicenter/workspace';
import { openFuji } from './browser';
import { deviceId } from './device-id';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export const fuji = openFuji({ auth });

// Publish device identity + offered actions into awareness so other peers
// can discover what this Fuji instance handles. Written once at boot;
// awareness echoes it to every peer in the workspace.
fuji.awareness.setLocal({
	device: {
		id: deviceId,
		name: 'Fuji',
		platform: 'web',
		offers: actionManifest(fuji.actions),
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
