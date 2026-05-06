import type { AuthIdentity } from '@epicenter/auth';
import { createCookieAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';

export type { AuthIdentity } from '@epicenter/auth';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

export const protectedAuth = {
	get identity(): AuthIdentity {
		if (auth.state.status !== 'signed-in') {
			throw new Error('Protected auth read outside signed-in subtree');
		}

		return auth.state.identity;
	},
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
