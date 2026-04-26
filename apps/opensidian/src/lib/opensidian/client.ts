import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { actionManifest } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { openOpensidian } from './browser';
import { deviceId } from './device-id';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
});

export const opensidian = openOpensidian({ auth });

opensidian.awareness.setLocal({
	device: {
		id: deviceId,
		name: 'Opensidian',
		platform: 'web',
		offers: actionManifest(opensidian.actions),
	},
});

auth.onSessionChange((next, previous) => {
	if (next === null) {
		opensidian.sync.goOffline();
		if (previous !== null) void opensidian.idb.clearLocal();
		return;
	}
	opensidian.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) opensidian.sync.reconnect();
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
