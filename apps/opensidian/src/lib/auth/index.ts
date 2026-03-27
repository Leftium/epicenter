import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	AuthSession,
	createAuthTransport,
	createAuthSession,
} from '@epicenter/svelte/auth';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: AuthSession,
	defaultValue: { status: 'anonymous' },
});

const authTransport = createAuthTransport({
	baseURL: APP_URLS.API,
});

export function startGoogleSignIn(): Promise<void> {
	return authTransport.startGoogleSignInRedirect({
		callbackURL: window.location.origin,
	});
}

export const authState = createAuthSession({
	storage: session,
	resolveSession: authTransport.resolveSession,
	commands: {
		signIn: authTransport.signInWithPassword,
		signUp: authTransport.signUpWithPassword,
	},
	signOutRemote: authTransport.signOutRemote,
});
