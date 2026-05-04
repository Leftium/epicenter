import { createBrowserAuth } from '@epicenter/auth-svelte';

export const auth = createBrowserAuth({
	baseURL: window.location.origin,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
