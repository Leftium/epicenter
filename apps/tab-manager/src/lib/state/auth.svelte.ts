/**
 * Auth state for the tab manager Chrome extension.
 *
 * Uses the shared auth transport + session store primitives with the extension's
 * two real seams: custom Google OAuth (`chrome.identity`) and chrome-backed
 * session persistence.
 *
 * @see {@link @epicenter/svelte/auth!createAuthSession} — session store
 * @see {@link ./storage-state.svelte} — chrome.storage reactive wrapper
 * @see {@link ./key-cache} — session-scoped user-key cache
 */

import {
	AuthSession,
	createAuthSession,
	createAuthTransport,
} from '@epicenter/svelte/auth';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { workspace } from '$lib/workspace';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';

const GOOGLE_CLIENT_ID =
	'702083743841-820rm0nhf9kslmvqcikecgkmku5agbbi.apps.googleusercontent.com';

/** Persisted auth snapshot in `chrome.storage.local`. */
const authSession = createStorageState('local:authSession', {
	fallback: { status: 'anonymous' },
	schema: AuthSession,
});

const transport = createAuthTransport({
	baseURL: () => remoteServerUrl.current,
	signInWithGoogle: async (betterAuthClient) => {
		const redirectUri = browser.identity.getRedirectURL();
		const nonce = crypto.randomUUID();
		const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
		authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
		authUrl.searchParams.set('redirect_uri', redirectUri);
		authUrl.searchParams.set('response_type', 'id_token');
		authUrl.searchParams.set('scope', 'openid email profile');
		authUrl.searchParams.set('nonce', nonce);

		const responseUrl = await browser.identity.launchWebAuthFlow({
			url: authUrl.toString(),
			interactive: true,
		});
		if (!responseUrl) throw new Error('No response from Google');

		const fragment = new URL(responseUrl).hash.substring(1);
		const params = new URLSearchParams(fragment);
		const idToken = params.get('id_token');
		if (!idToken) throw new Error('No id_token in response');

		const { data, error } = await betterAuthClient.signIn.social({
			provider: 'google',
			idToken: { token: idToken, nonce },
		});
		if (error) throw new Error(error.message ?? error.statusText);
		if (!data || !('user' in data)) {
			throw new Error('Unexpected response from server');
		}
		return data;
	},
});

export const authState = createAuthSession({
	storage: authSession,
	transport,
	onSessionCommitted: async ({
		previous,
		current,
		reason,
		userKeyBase64,
	}) => {
		if (current.status === 'authenticated') {
			if (userKeyBase64) {
				await workspace.encryption.unlock(base64ToBytes(userKeyBase64));
				return;
			}

			if (
				reason === 'bootstrap' ||
				reason === 'external-change' ||
				previous.status !== 'authenticated'
			) {
				await workspace.encryption.tryUnlock();
			}

			return;
		}

		if (previous.status === 'authenticated') {
			await workspace.clearLocalData();
		}
	},
});
