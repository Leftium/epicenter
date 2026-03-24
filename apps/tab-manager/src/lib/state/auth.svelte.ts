/**
 * Auth state for the tab manager Chrome extension.
 *
 * Thin wrapper around the shared `createAuthState` factory, providing:
 *
 * - **chrome.storage** — `createStorageState` for token and user, with
 *   async init (`whenReady`) and cross-context change detection (`.watch`)
 * - **Google OAuth** — `chrome.identity.launchWebAuthFlow` to acquire a
 *   Google `id_token`, which the factory exchanges via Better Auth
 * - **Encryption lifecycle** — activates workspace encryption from the
 *   server key on sign-in, restores from a session-scoped key cache
 *   on startup and cross-context sign-in
 * - **Cross-context sync** — watchers on `authToken` and `authUser`
 *   detect sign-in/out from other extension contexts (popup, sidebar,
 *   background) and transition the phase machine accordingly
 *
 * @see {@link @epicenter/svelte/auth-state!createAuthState} — shared factory
 * @see {@link ./storage-state.svelte} — chrome.storage reactive wrapper
 * @see {@link ./key-cache} — session-scoped encryption key cache
 */

import { createAuthState, AuthUser } from '@epicenter/svelte/auth-state';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { workspace } from '$lib/workspace';
import { keyCache } from './key-cache';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';
import { type } from 'arktype';

const GOOGLE_CLIENT_ID =
	'702083743841-820rm0nhf9kslmvqcikecgkmku5agbbi.apps.googleusercontent.com';

/** Bearer token in `chrome.storage.local`. Read synchronously via `$state`. */
const authToken = createStorageState('local:authToken', {
	fallback: undefined,
	schema: type('string').or('undefined'),
});

/** Cached user in `chrome.storage.local`. Validated against `AuthUser` schema. */
const authUser = createStorageState('local:authUser', {
	fallback: undefined,
	schema: AuthUser.or('undefined'),
});

/**
 * Load the encryption key from the session-scoped key cache and activate
 * workspace encryption. Used for instant startup (before the server
 * roundtrip) and cross-context sign-in (where no server key is available).
 * The server's authoritative key supersedes this via `onSignedIn` once
 * `checkSession` completes.
 */
async function restoreEncryptionFromCache() {
	const cached = await keyCache.load();
	if (cached) await workspace.activateEncryption(base64ToBytes(cached));
}

export const authState = createAuthState({
	baseURL: () => remoteServerUrl.current,
	storage: { token: authToken, user: authUser },
	whenReady: Promise.all([authToken.whenReady, authUser.whenReady]),
	async onCheckSessionStart() {
		if (authUser.current?.id) await restoreEncryptionFromCache();
	},
	async getGoogleIdToken() {
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
		const token = params.get('id_token');
		if (!token) throw new Error('No id_token in response');

		return { token, nonce };
	},
	async onSignedIn(encryptionKey) {
		await workspace.activateEncryption(base64ToBytes(encryptionKey));
	},
	async onSignedOut() {
		await workspace.deactivateEncryption();
	},
	async onExternalSignIn() {
		await restoreEncryptionFromCache();
	},
});

// ─── Cross-context watchers ──────────────────────────────────────────────────
//
// Chrome extensions have multiple JS contexts (popup, sidebar, background).
// `createStorageState.watch()` fires when ANOTHER context writes to
// chrome.storage. Phase transitions happen synchronously; encryption
// lifecycle runs as fire-and-forget via the factory callbacks.

/** Sign-out in another context: token cleared → deactivate encryption. */
authToken.watch((token) => {
	if (!token && authState.status === 'signed-in') {
		authState.handleExternalSignOut();
	}
});

/** Sign-in in another context: user set → restore encryption from cache. */
authUser.watch((user) => {
	if (user && authToken.current && authState.status === 'signed-out') {
		authState.handleExternalSignIn();
	}
});
