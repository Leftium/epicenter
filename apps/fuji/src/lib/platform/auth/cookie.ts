import { createCookieAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';

export const auth = createCookieAuth({
	baseURL: APP_URLS.API,
	getSocialCallbackURL: () => window.location.href,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
