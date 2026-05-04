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
			// The workspace bundle owns teardown order. Its disposer closes child
			// document caches and destroys the root Y.Doc, which tells attachments
			// like sync, broadcast channel, and y-indexeddb to stop before local
			// IndexedDB data is deleted.
			honeycrisp[Symbol.dispose]();
			// This is safe after disposal. y-indexeddb deletes by database name,
			// and any row data needed to compute child document names remains
			// readable from memory after Y.Doc.destroy(); disposal has already
			// stopped observers and providers.
			await honeycrisp.clearLocalData();
		} catch (error) {
			toast.error('Could not clear local data', {
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
	});
}
