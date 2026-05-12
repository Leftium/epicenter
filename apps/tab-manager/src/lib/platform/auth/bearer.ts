/**
 * Auth state for the tab manager Chrome extension.
 *
 * Exports persisted session storage and the OAuth sign-in adapter. The
 * auth client itself is created after storage readiness in `../../session.svelte`.
 *
 * @see {@link ../../session.svelte} auth, workspace, and identity wiring
 * @see {@link ../../state/storage-state.svelte} chrome.storage reactive wrapper
 */

import { BearerSession } from '@epicenter/auth-svelte';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import { createExtensionOAuthAdapter } from '@epicenter/oauth-client';
import { createStorageState } from '../../state/storage-state.svelte';

/**
 * Persisted bearer session in `chrome.storage.local`.
 */
export const authSessionStorage = createStorageState('local:auth.session', {
	fallback: null,
	schema: BearerSession.or('null'),
});

export const oauthSignInAdapter = createExtensionOAuthAdapter({
	issuer: `${APP_URLS.API}/auth`,
	clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
	redirectUri: browser.identity.getRedirectURL(),
	resource: APP_URLS.API,
	storage: {
		async getItem(key) {
			const result = await browser.storage.session.get(key);
			const value = result[key];
			return typeof value === 'string' ? value : null;
		},
		async setItem(key, value) {
			await browser.storage.session.set({ [key]: value });
		},
		async removeItem(key) {
			await browser.storage.session.remove(key);
		},
	},
	async launchWebAuthFlow(url) {
		const responseUrl = await browser.identity.launchWebAuthFlow({
			url,
			interactive: true,
		});
		if (!responseUrl) throw new Error('No response from Epicenter sign-in.');
		return responseUrl;
	},
});
