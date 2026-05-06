import { createCookieAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';

export type { AuthIdentity } from '@epicenter/auth';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
