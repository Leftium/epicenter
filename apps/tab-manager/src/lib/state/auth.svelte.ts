/**
 * Auth state for the tab manager Chrome extension.
 *
 * Uses the shared auth client with the extension's two seams: custom Google
 * OAuth (`chrome.identity`) and chrome-backed session persistence.
 *
 * @see {@link @epicenter/svelte/auth!createAuth} — unified auth client
 * @see {@link ./storage-state.svelte} — chrome.storage reactive wrapper
 * @see {@link ./key-cache} — session-scoped user-key cache
 */

import {
	AuthSession,
	createAuth,
} from '@epicenter/svelte/auth';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';

const GOOGLE_CLIENT_ID =
	'702083743841-820rm0nhf9kslmvqcikecgkmku5agbbi.apps.googleusercontent.com';

/** Persisted auth snapshot in `chrome.storage.local`. */
const authSession = createStorageState('local:authSession', {
	fallback: { status: 'anonymous' },
	schema: AuthSession,
});

const authBaseURL = () => remoteServerUrl.current;

async function getGoogleCredentials(): Promise<{ idToken: string; nonce: string }> {
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

	return { idToken, nonce };
}

export const authState = createAuth({
	baseURL: authBaseURL,
	session: authSession,
	signInWithGoogle: getGoogleCredentials,
});
