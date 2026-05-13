import { OAuthSession } from '@epicenter/auth';
import { createOAuthAppAuth } from '@epicenter/auth-svelte';
import { EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	createBrowserOAuthLauncher,
	createStorageAdapter,
} from '@epicenter/oauth-client';
import { createPersistedState } from '@epicenter/svelte';
import { base } from '$app/paths';

export const auth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
	sessionStorage: createPersistedState({
		key: 'opensidian.auth.session',
		schema: OAuthSession.or('null'),
		defaultValue: null,
	}),
	launcher: createBrowserOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
		redirectUri: `${window.location.origin}${base}/auth/callback`,
		resource: APP_URLS.API,
		storage: createStorageAdapter(window.sessionStorage),
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
