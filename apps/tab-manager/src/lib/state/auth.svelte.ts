/**
 * Auth state wrapper for tab manager extension.
 *
 * Wraps the shared `createAuthState` factory with extension-specific storage
 * (chrome.storage via createStorageState) and cross-context synchronization.
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

const authToken = createStorageState('local:authToken', {
	fallback: undefined,
	schema: type('string').or('undefined'),
});

const authUser = createStorageState('local:authUser', {
	fallback: undefined,
	schema: AuthUser.or('undefined'),
});

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

authToken.watch((token) => {
	if (!token && authState.status === 'signed-in') {
		authState.handleExternalSignOut();
	}
});

authUser.watch((user) => {
	if (user && authToken.current && authState.status === 'signed-out') {
		authState.handleExternalSignIn();
	}
});
