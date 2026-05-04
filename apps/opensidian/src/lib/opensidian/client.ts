import { BearerSession, createBearerAuth } from '@epicenter/auth-svelte';
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
	schema: BearerSession.or('null'),
	defaultValue: null,
});

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	initialSession: session.get(),
	saveSession: (next) => session.set(next),
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
	applyAuthIdentity(session) {
		opensidian.encryption.applyKeys(session.encryptionKeys);
	},
	async resetLocalClient() {
		try {
			// The workspace bundle owns teardown order. Its disposer closes child
			// document caches and destroys the root Y.Doc, which tells attachments
			// like sync, broadcast channel, and y-indexeddb to stop before local
			// IndexedDB data is deleted.
			opensidian[Symbol.dispose]();
			// This is safe after disposal. y-indexeddb deletes by database name,
			// and any row data needed to compute child document names remains
			// readable from memory after Y.Doc.destroy(); disposal has already
			// stopped observers and providers.
			await opensidian.clearLocalData();
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

/** AI tool representations for the opensidian workspace. */
export const workspaceAiTools = actionsToAiTools(opensidian.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;
