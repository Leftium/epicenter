import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	AuthSession,
	createAuthTransport,
	createAuthSession,
} from '@epicenter/svelte/auth';

const session = createPersistedState({
	key: 'zhongwen:authSession',
	schema: AuthSession,
	defaultValue: { status: 'anonymous' },
});

export const authTransport = createAuthTransport({
	baseURL: APP_URLS.API,
});

export const authState = createAuthSession({
	storage: session,
	resolveSession: authTransport.resolveSession,
	signOutRemote: authTransport.signOutRemote,
});
