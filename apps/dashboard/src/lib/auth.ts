import {
	AuthSession,
	createAuth,
} from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

const session = createPersistedState({
	key: 'dashboard:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: window.location.origin,
	initialSession: session.get(),
	saveSession: (next) => session.set(next),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
