import { BearerSession, createBearerAuth } from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

export const auth = createBearerAuth({
	baseURL: window.location.origin,
	sessionStorage: createPersistedState({
		key: 'dashboard.auth.session',
		schema: BearerSession.or('null'),
		defaultValue: null,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
