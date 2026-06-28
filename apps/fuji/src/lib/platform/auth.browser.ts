import { EPICENTER_FUJI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createHostedBrowserRedirectAuth } from '@epicenter/svelte/auth';
import { instanceSetting } from '$lib/instance';
import type { PlatformAuth } from './types';

export const auth: PlatformAuth = createHostedBrowserRedirectAuth({
	instanceSetting,
	namespace: 'fuji',
	clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
	api: APP_URLS.API,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
