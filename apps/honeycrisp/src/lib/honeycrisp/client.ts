import { BearerSession, createAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { toast } from '@epicenter/ui/sonner';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { openHoneycrisp } from './browser';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: BearerSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	initialSession: session.get(),
	saveSession: (next) => session.set(next),
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
	syncControl: honeycrisp.syncControl,
	applyAuthIdentity(session) {
		honeycrisp.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await honeycrisp.clearLocalData();
			window.location.reload();
		} catch (error) {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		}
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
