import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	AuthSession,
	createAuthSession,
	createSessionResolver,
	startGoogleSignInRedirect,
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

export function startGoogleSignIn(): Promise<void> {
	return startGoogleSignInRedirect({
		baseURL: APP_URLS.API,
		callbackURL: window.location.origin,
	});
}

export const authState = createAuthSession({
	storage: session,
	resolveSession,
	signOutRemote: (current) => signOutRemote({ baseURL: APP_URLS.API, current }),
});
