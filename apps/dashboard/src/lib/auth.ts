import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { createPersistedState, fromPersistedState } from '@epicenter/svelte';

const sessionState = createPersistedState({
	key: 'dashboard:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: window.location.origin,
	session: fromPersistedState(sessionState),
});
