/**
 * RFC 8628 Device Authorization Grant flow.
 *
 * Used for headless/CLI auth where a browser-based login is required.
 * The user visits a URL, enters a code, and the CLI polls until approved.
 */

import { createAuthApi } from './api';
import { saveSession } from './store';

/**
 * Authenticate with an Epicenter server using the RFC 8628 device code flow.
 *
 * Initiates a device authorization request, prints the verification URL and user code,
 * then polls until the user completes authorization or the request expires.
 * On success, fetches user info and saves the session to the unified auth store.
 */
export async function loginWithDeviceCode(
	serverUrl: string,
	home: string,
): Promise<void> {
	const api = createAuthApi(serverUrl);
	const codeData = await api.requestDeviceCode();

	console.log(`\nVisit: ${codeData.verification_uri_complete}`);
	console.log(`Enter code: ${codeData.user_code}\n`);

	let interval = codeData.interval * 1000;

	while (true) {
		await Bun.sleep(interval);

		const tokenData = await api.pollDeviceToken(codeData.device_code);

		if ('access_token' in tokenData) {
			const { access_token: accessToken, expires_in: expiresIn } = tokenData;

			const authed = createAuthApi(serverUrl, accessToken);
			const sessionData = await authed.getSession();
			const { user, userKeyBase64 } = sessionData;

			await saveSession(home, {
				server: serverUrl,
				accessToken,
				createdAt: Date.now(),
				expiresIn,
				user,
				userKeyBase64,
			});

			const displayName = user?.name ?? user?.email ?? serverUrl;
			console.log(`\u2713 Logged in as ${displayName}`);
			return;
		}

		switch (tokenData.error) {
			case 'authorization_pending':
				continue;
			case 'slow_down':
				interval *= 2;
				continue;
			case 'expired_token':
				throw new Error('Device code expired \u2014 please run login again');
			case 'access_denied':
				throw new Error('Authorization denied \u2014 you rejected the request');
			default:
				throw new Error(
					tokenData.error_description ?? tokenData.error,
				);
		}
	}
}
