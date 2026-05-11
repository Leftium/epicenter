import { createCookieAuth } from '@epicenter/auth-svelte';

export const auth = createCookieAuth({
	baseURL: window.location.origin,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
