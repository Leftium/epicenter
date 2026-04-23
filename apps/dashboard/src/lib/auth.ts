import { AuthSession, createAuth } from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

export const auth = createAuth({
	baseURL: window.location.origin,
	session: createPersistedState({
		key: 'dashboard:authSession',
		schema: AuthSession.or('null'),
		defaultValue: null,
	}),
});
