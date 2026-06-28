import { EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createHostedBrowserRedirectAuth } from '@epicenter/svelte/auth';
import { base } from '$app/paths';
import { instanceSetting } from '$lib/instance';

export const auth = createHostedBrowserRedirectAuth({
	instanceSetting,
	namespace: 'opensidian',
	clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
	api: APP_URLS.API,
	basePath: base,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
