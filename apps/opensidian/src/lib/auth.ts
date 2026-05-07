import { BearerSession, createBearerAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';

const authSession = createPersistedState({
	key: 'opensidian:authSession',
	schema: BearerSession.or('null'),
	defaultValue: null,
});

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	initialSession: authSession.get(),
	saveSession: (next) => authSession.set(next),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
