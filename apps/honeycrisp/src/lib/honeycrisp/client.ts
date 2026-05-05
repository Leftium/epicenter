import { createCookieAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { openHoneycrisp } from './browser';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

await auth.whenReady;
if (auth.identity === null) {
	throw new Error(
		'Cannot open Honeycrisp workspace: auth identity is required.',
	);
}

export const honeycrisp = openHoneycrisp({
	auth,
	identity: auth.identity,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Honeycrisp',
		platform: 'web',
	},
});

bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity(session) {
		honeycrisp.encryption.applyKeys(session.encryptionKeys);
	},
	onSignOut() {
		window.location.reload();
	},
	onIdentityChanged() {
		window.location.reload();
	},
});

export async function forgetHoneycrispDevice(): Promise<void> {
	await honeycrisp.wipe();
	window.location.reload();
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
		honeycrisp[Symbol.dispose]();
	});
}
