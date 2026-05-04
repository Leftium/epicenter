import {
	createAuth,
	createSessionStorageAdapter,
	Session,
} from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { toast } from '@epicenter/ui/sonner';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { openHoneycrisp } from './browser';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
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
	applyAuthSession(session) {
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
