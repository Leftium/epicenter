import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { createOAuthAppAuth } from '@epicenter/auth-svelte';
import { EPICENTER_DASHBOARD_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { base } from '$app/paths';

const apiBaseURL = window.location.origin;

export const auth = createOAuthAppAuth({
	baseURL: apiBaseURL,
	clientId: EPICENTER_DASHBOARD_OAUTH_CLIENT_ID,
	persistedAuthStorage: createWebStoragePersistedAuthStorage({
		key: 'dashboard.auth.persisted',
		storage: window.localStorage,
	}),
	launcher: createBrowserOAuthLauncher({
		issuer: `${apiBaseURL}/auth`,
		clientId: EPICENTER_DASHBOARD_OAUTH_CLIENT_ID,
		redirectUri: `${window.location.origin}${base}/auth/callback`,
		resource: apiBaseURL,
		storage: window.sessionStorage,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
