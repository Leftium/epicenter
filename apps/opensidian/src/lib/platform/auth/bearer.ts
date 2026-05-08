import { BearerSession, createBearerAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createPersistedState({
		key: 'opensidian.auth.session',
		schema: BearerSession.or('null'),
		defaultValue: null,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
