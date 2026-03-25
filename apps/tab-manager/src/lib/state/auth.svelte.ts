/**
 * Auth state for the tab manager Chrome extension.
 *
 * Thin wrapper around the shared workspace auth factory, providing:
 *
 * - **chrome.storage** — `createStorageState` for token and user, with
 *   async init (`whenReady`) and cross-context change detection (`.watch`)
 * - **Google OAuth auth API** — extension-specific Better Auth auth API
 *   built on `chrome.identity.launchWebAuthFlow`
 * - **Workspace auth** — signed-in means the workspace is decrypted, and
 *   sign-out tears it back down
 * - **Cross-context sync** — `createReactiveSessionStore()` forwards
 *   `chrome.storage` changes into the shared auth controller
 *
 * @see {@link @epicenter/svelte/auth-state!createWorkspaceAuthState} — shared factory
 * @see {@link ./storage-state.svelte} — chrome.storage reactive wrapper
 * @see {@link ./key-cache} — session-scoped encryption key cache
 */

import {
	createAuthApi,
	createReactiveSessionStore,
	createWorkspaceAuthState,
	StoredUser,
} from '@epicenter/svelte/auth-state';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import { workspace } from '$lib/workspace';
import { keyCache } from './key-cache';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';

const GOOGLE_CLIENT_ID =
	'702083743841-820rm0nhf9kslmvqcikecgkmku5agbbi.apps.googleusercontent.com';

/** Bearer token in `chrome.storage.local`. Read synchronously via `$state`. */
const authToken = createStorageState('local:authToken', {
	fallback: null,
	schema: type('string').or('null'),
});

/** Cached user in `chrome.storage.local`. Validated against `StoredUser` schema. */
const authUser = createStorageState('local:authUser', {
	fallback: null,
	schema: StoredUser.or('null'),
});

const authApi = createAuthApi({
	baseURL: () => remoteServerUrl.current,
	signInWithGoogle: async (client) => {
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

		const { data, error } = await client.signIn.social({
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

const sessionStore = createReactiveSessionStore({
	token: authToken,
	user: authUser,
	ready: Promise.all([authToken.whenReady, authUser.whenReady]),
});

export const authState = createWorkspaceAuthState({
	authApi,
	sessionStore,
	workspace,
	restoreUserKey: async () => {
		const cached = await keyCache.load();
		return cached ? base64ToBytes(cached) : null;
	},
});
