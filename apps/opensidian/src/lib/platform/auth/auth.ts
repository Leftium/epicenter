import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAppAuthClient } from '@epicenter/svelte/auth';
import { base } from '$app/paths';
import { instanceSetting } from '$lib/instance';

// One choke point: the persisted instance picks hosted OAuth vs a self-host
// token (ADR-0071). The launcher is built once from the hosted constants, never
// the instance base URL, because OAuth runs only against the hosted star.
export const auth = createAppAuthClient(instanceSetting.read(), {
	clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
	persistedAuthStorage: createWebStoragePersistedAuthStorage({
		key: 'opensidian.auth.persisted',
		storage: window.localStorage,
	}),
	launcher: createBrowserOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
		redirectUri: `${window.location.origin}${base}/auth/callback`,
		resource: APP_URLS.API,
		storage: window.sessionStorage,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
