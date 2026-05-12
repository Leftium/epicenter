/**
 * Auth state for the tab manager Chrome extension.
 *
 * Exports persisted session storage and the OAuth sign-in launcher. The
 * auth client itself is created after storage readiness in
 * `../../session.svelte`.
 *
 * @see {@link ../../session.svelte} auth, workspace, and identity wiring
 * @see {@link ../../state/storage-state.svelte} chrome.storage reactive wrapper
 */

import { OAuthSession } from '@epicenter/auth-svelte';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import { createExtensionOAuthLauncher } from '@epicenter/oauth-client';
import { createStorageState } from '../../state/storage-state.svelte';

/**
 * Persisted OAuth session in `chrome.storage.local`.
 *
 * Older builds persisted a `BearerSession`-shaped value at this key. After
 * this migration, schema validation fails for the legacy shape and the
 * session reads as null, forcing a one-time sign-in. Workspace IndexedDB
 * data is keyed by userId and survives the reset.
 */
export const authSessionStorage = createStorageState('local:auth.session', {
	fallback: null,
	schema: OAuthSession.or('null'),
});

export const oauthLauncher = createExtensionOAuthLauncher({
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
