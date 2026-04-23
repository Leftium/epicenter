/**
 * Auth state for the tab manager Chrome extension.
 *
 * Exports the persisted session store (adapted to `SessionStore`) and the
 * Google credentials helper. The `auth` instance itself lives in
 * `./client.svelte` alongside the workspace.
 *
 * @see {@link ./client.svelte} — auth + workspace + onSessionChange wiring
 * @see {@link ./state/storage-state.svelte} — chrome.storage reactive wrapper
 */

import { AuthSession } from '@epicenter/auth-svelte';
import {
	createStorageState,
	fromStorageState,
} from './state/storage-state.svelte';

const GOOGLE_CLIENT_ID =
	'702083743841-820rm0nhf9kslmvqcikecgkmku5agbbi.apps.googleusercontent.com';

const sessionState = createStorageState('local:authSession', {
	fallback: null,
	schema: AuthSession.or('null'),
});

/** Persisted auth snapshot in `chrome.storage.local`, adapted to `SessionStore`. */
export const session = fromStorageState(sessionState);

export async function getGoogleCredentials(): Promise<{
	idToken: string;
	nonce: string;
}> {
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
