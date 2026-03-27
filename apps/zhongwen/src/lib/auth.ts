import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	AuthSession,
	createAuthSession,
	createBetterAuthClientSession,
	createSessionResolver,
	signOutRemote,
} from '@epicenter/svelte/auth';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { workspace } from '$lib/workspace/client';

const session = createPersistedState({
	key: 'zhongwen:authSession',
	schema: AuthSession,
	defaultValue: { status: 'anonymous' },
});

const resolveSession = createSessionResolver({
	baseURL: APP_URLS.API,
});

export const authState = createAuthSession({
	storage: session,
	resolveSession,
	commands: {
		signInWithGoogle: async () => {
			const { client } = createBetterAuthClientSession({
				baseURL: APP_URLS.API,
				authToken: null,
			});
			await client.signIn.social({
				provider: 'google',
				callbackURL: window.location.origin,
			});
			return { status: 'redirect-started' };
		},
	},
	signOutRemote: (current) => signOutRemote({ baseURL: APP_URLS.API, current }),
	onSessionCommitted: async ({ previous, current, reason, userKeyBase64 }) => {
		if (current.status === 'authenticated') {
			if (userKeyBase64) {
				await workspace.encryption.unlock(base64ToBytes(userKeyBase64));
				return;
			}

			if (
				reason === 'bootstrap' ||
				reason === 'external-change' ||
				previous.status !== 'authenticated'
			) {
				await workspace.encryption.tryUnlock();
			}

			return;
		}

		if (previous.status === 'authenticated') {
			await workspace.clearLocalData();
		}
	},
});
