import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createTauriDeepLinkOAuthLauncher } from '@epicenter/auth/oauth-launchers/tauri';
import {
	EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAppAuthClient } from '@epicenter/svelte/auth';
import { instanceSetting } from '$lib/instance';
import type { PlatformAuth } from './types';

// One choke point: the persisted instance picks hosted OAuth vs a self-host
// token (ADR-0071). The deep-link launcher is built once from the hosted
// constants, never the instance base URL, because OAuth runs only against the
// hosted star.
export const auth: PlatformAuth = createAppAuthClient(instanceSetting.read(), {
	clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	persistedAuthStorage: createWebStoragePersistedAuthStorage({
		key: 'whispering.auth.persisted',
		storage: window.localStorage,
	}),
	launcher: createTauriDeepLinkOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
		resource: APP_URLS.API,
		redirectUri: EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
		// Deep-link callbacks can cold-start the app; localStorage (not
		// sessionStorage) keeps the PKCE transaction alive across the launch.
		storage: window.localStorage,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
