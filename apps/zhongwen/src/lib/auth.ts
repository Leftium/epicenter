import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	AuthSession,
	createAuthSession,
	createBetterAuthClientSession,
	createSessionResolver,
	signOutRemote,
} from '@epicenter/svelte/auth';

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
});
