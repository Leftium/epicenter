import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { AuthSession, createAuth } from '@epicenter/svelte/auth';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: AuthSession,
	defaultValue: { status: 'anonymous' },
});

export const authState = createAuth({
	baseURL: APP_URLS.API,
	session,
});
