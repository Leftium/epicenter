import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	AuthSession,
	createAuthSession,
	createSessionResolver,
	startGoogleSignInRedirect,
	signInWithPassword,
	signOutRemote,
	signUpWithPassword,
} from '@epicenter/svelte/auth';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: AuthSession,
	defaultValue: { status: 'anonymous' },
});

const resolveSession = createSessionResolver({
	baseURL: APP_URLS.API,
});

export function startGoogleSignIn(): Promise<void> {
	return startGoogleSignInRedirect({
		baseURL: APP_URLS.API,
		callbackURL: window.location.origin,
	});
}

export const authState = createAuthSession({
	storage: session,
	resolveSession,
	commands: {
		signIn: (input) => signInWithPassword({ baseURL: APP_URLS.API, input }),
		signUp: (input) => signUpWithPassword({ baseURL: APP_URLS.API, input }),
	},
	signOutRemote: (current) => signOutRemote({ baseURL: APP_URLS.API, current }),
});
