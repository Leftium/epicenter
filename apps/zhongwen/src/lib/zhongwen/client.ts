import { createCookieAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { toast } from '@epicenter/ui/sonner';
import { extractErrorMessage } from 'wellcrafted/error';
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
	async resetLocalClient() {
		try {
			// The workspace bundle owns teardown order. Its disposer destroys the
			// root Y.Doc, which tells attachments like broadcast channel and
			// y-indexeddb to stop before local IndexedDB data is deleted.
			zhongwen[Symbol.dispose]();
			// This is safe after disposal. y-indexeddb deletes by database name,
			// and any row data needed to compute child document names remains
			// readable from memory after Y.Doc.destroy(); disposal has already
			// stopped observers and providers.
			await zhongwen.clearLocalData();
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
