import { createCookieAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { openZhongwen } from './browser';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

await auth.whenReady;
if (auth.identity === null) {
	throw new Error('Cannot open Zhongwen workspace: auth identity is required.');
}

export const zhongwen = openZhongwen({ auth });

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

export async function forgetZhongwenDevice(): Promise<void> {
	await zhongwen.wipe();
	window.location.reload();
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
		zhongwen[Symbol.dispose]();
	});
}
