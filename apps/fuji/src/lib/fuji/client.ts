import {
	createAuth,
	createSessionStorageAdapter,
	Session,
} from '@epicenter/auth-svelte';
import { bindWorkspaceAuthLifecycle } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { toast } from '@epicenter/ui/sonner';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { openFuji } from './browser';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

export const fuji = openFuji({
	auth,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Fuji',
		platform: 'web',
	},
});

bindWorkspaceAuthLifecycle({
	auth,
	workspace: fuji,
	leavingUser: {
		afterCleanup: () => window.location.reload(),
		onCleanupError: (error) => {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		},
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
