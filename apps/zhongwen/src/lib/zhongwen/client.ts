import { createCookieAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { openZhongwen } from './browser';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

export const zhongwen = openZhongwen();

bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity(session) {
		zhongwen.encryption.applyKeys(session.encryptionKeys);
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
		zhongwen[Symbol.dispose]();
	});
}
