import { createCookieAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { toast } from '@epicenter/ui/sonner';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { openFuji } from './browser';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

export const fuji = openFuji({
	auth,
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
	async resetLocalClient() {
		try {
			fuji.entryContentDocs[Symbol.dispose]();
			fuji.ydoc.destroy();
			await fuji.clearLocalData();
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
