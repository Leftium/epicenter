import {
	createAuth,
	createSessionStorageAdapter,
} from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { toast } from '@epicenter/ui/sonner';
import { extractErrorMessage } from 'wellcrafted/error';
import { session } from '$lib/auth';
import { openZhongwen } from './browser';

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

export const zhongwen = openZhongwen();

bindAuthWorkspaceScope({
	auth,
	sync: null,
	applyAuthSession(session) {
		zhongwen.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await zhongwen.idb.clearLocal();
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
