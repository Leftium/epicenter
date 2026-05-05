import { createCookieAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { openFuji } from './browser';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

await auth.whenReady;
if (auth.identity === null) {
	throw new Error('Cannot open Fuji workspace: auth identity is required.');
}

export const fuji = openFuji({
	auth,
	identity: auth.identity,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Fuji',
		platform: 'web',
	},
});

bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity(session) {
		fuji.encryption.applyKeys(session.encryptionKeys);
	},
	onSignOut() {
		window.location.reload();
	},
	onIdentityChanged() {
		window.location.reload();
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
		fuji[Symbol.dispose]();
	});
}
