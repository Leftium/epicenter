import { BearerSession, createBearerAuth } from '@epicenter/auth-svelte';
import { EPICENTER_OPENSIDIAN_LOCAL_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import { createBrowserOAuthAdapter } from '@epicenter/oauth-client';
import { createPersistedState } from '@epicenter/svelte';
import { base } from '$app/paths';

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	oauthAdapter: createBrowserOAuthAdapter({
		apiBaseURL: APP_URLS.API,
		clientId: EPICENTER_OPENSIDIAN_LOCAL_OAUTH_CLIENT_ID,
		redirectUri: `${window.location.origin}${base}/auth/callback`,
	}),
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
