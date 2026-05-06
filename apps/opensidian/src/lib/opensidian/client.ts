import {
	BearerSession,
	createBearerAuth,
	waitForAuthState,
} from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
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

const signedInState = await waitForAuthState(
	auth,
	(state) => state.status === 'signed-in',
);
if (signedInState.status !== 'signed-in') {
	throw new Error('Cannot open Opensidian workspace: signed-in auth required.');
}

export const opensidian = openOpensidian({
	identity: signedInState.identity,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Opensidian',
		platform: 'web',
	},
	bearerToken: () => auth.bearerToken,
});

bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity(session) {
		opensidian.encryption.applyKeys(session.encryptionKeys);
	},
	onSignOut() {
		window.location.reload();
	},
	onIdentityChanged() {
		window.location.reload();
	},
});

export async function forgetOpensidianDevice(): Promise<void> {
	await opensidian.wipe();
	window.location.reload();
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
		opensidian[Symbol.dispose]();
	});
}

/** AI tool representations for the opensidian workspace. */
export const workspaceAiTools = actionsToAiTools(opensidian.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;
