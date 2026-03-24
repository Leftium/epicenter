/**
 * Auth state wrapper for tab manager extension.
 *
 * Wraps the shared `createAuthState` factory with extension-specific storage
 * (chrome.storage via createStorageState) and cross-context synchronization.
 */

import { createAuthState, type AuthUser } from '@epicenter/svelte/auth-state';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { workspace } from '$lib/workspace';
import { keyCache } from './key-cache';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';
import { type } from 'arktype';

const AuthUserSchema = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

// Public Google OAuth client ID
const GOOGLE_CLIENT_ID =
	'702083743841-820rm0nhf9kslmvqcikecgkmku5agbbi.apps.googleusercontent.com';

// Reactive auth token and user from chrome.storage
const authToken = createStorageState('local:authToken', {
	fallback: undefined,
	schema: type('string').or('undefined'),
});

const authUser = createStorageState('local:authUser', {
	fallback: undefined,
	schema: AuthUserSchema.or('undefined'),
});

/**
 * Extract Google OAuth id_token via chrome.identity API and exchange for session.
 * Returns the authenticated AuthUser or throws.
 */
async function googleSignIn(): Promise<AuthUser> {
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

	const response = await fetch(`${remoteServerUrl.current}/auth/sign-in/social`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'google',
			idToken: { token: idToken, nonce },
		}),
		credentials: 'include',
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.message ?? response.statusText);
	}

	const data = await response.json();
	if (!data?.user) throw new Error('Unexpected response from server');

	// Extract auth token from response header
	const newToken = response.headers.get('set-auth-token');
	if (newToken) authToken.current = newToken;

	return data.user;
}

// Shared auth factory with extension-specific config
export const authState = createAuthState({
	baseURL: () => remoteServerUrl.current,
	storage: { token: authToken, user: authUser },
	whenReady: Promise.all([authToken.whenReady, authUser.whenReady]),
	async onCheckSessionStart() {
		const userId = authUser.current?.id;
		if (userId) {
			const cached = await keyCache.load();
			if (cached) await workspace.activateEncryption(base64ToBytes(cached));
		}
	},
	signInWithGoogle: googleSignIn,
	async onSignedIn(encryptionKey) {
		await workspace.activateEncryption(base64ToBytes(encryptionKey));
	},
	async onSignedOut() {
		await workspace.deactivateEncryption();
	},
	async onExternalSignIn() {
		const cached = await keyCache.load();
		if (cached) await workspace.activateEncryption(base64ToBytes(cached));
	},
});

// Cross-context watchers for chrome.storage changes from other extension contexts
// Token cleared externally → sign out
authToken.watch((token) => {
	if (!token && authState.status === 'signed-in') {
		authState.handleExternalSignOut();
	}
});

// User set externally → sign in and restore encryption from cache
authUser.watch((user) => {
	if (user && authToken.current && authState.status === 'signed-out') {
		authState.handleExternalSignIn();
	}
});
