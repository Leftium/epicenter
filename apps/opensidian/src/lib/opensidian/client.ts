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
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { extractErrorMessage } from 'wellcrafted/error';
import { openOpensidian } from './browser';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

export const opensidian = openOpensidian({
	auth,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Opensidian',
		platform: 'web',
	},
});

bindAuthWorkspaceScope({
	auth,
	syncControl: opensidian.syncControl,
	applyAuthSession(session) {
		opensidian.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			await opensidian.clearLocalData();
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

/** AI tool representations for the opensidian workspace. */
export const workspaceAiTools = actionsToAiTools(opensidian.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;
