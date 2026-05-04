import { createCookieAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { toast } from '@epicenter/ui/sonner';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { openHoneycrisp } from './browser';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

export const honeycrisp = openHoneycrisp({
	auth,
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
	async resetLocalClient() {
		try {
			await honeycrisp.wipe();
		} catch (error) {
			toast.error('Could not wipe local data', {
				description: extractErrorMessage(error),
			});
		} finally {
			window.location.reload();
		}
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
		honeycrisp[Symbol.dispose]();
	});
}
