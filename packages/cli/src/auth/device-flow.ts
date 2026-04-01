/**
 * RFC 8628 Device Authorization Grant flow.
 *
 * Used for headless/CLI auth where a browser-based login is required.
 * The user visits a URL, enters a code, and the CLI polls until approved.
 */

import { createAuthApi } from './api';
import type { SessionStore } from './store';

/**
 * Authenticate with an Epicenter server using the RFC 8628 device code flow.
 *
 * Initiates a device authorization request, prints the verification URL and user code,
 * then polls until the user completes authorization or the request expires.
 * On success, fetches the full session (user info + encryption key) and persists it.
 */
export async function loginWithDeviceCode(
	serverUrl: string,
	sessions: SessionStore,
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

			await sessions.save(serverUrl, {
				accessToken,
				expiresAt: Date.now() + expiresIn * 1000,
				userKeyBase64: sessionData.userKeyBase64,
				user: sessionData.user,
			});

			const displayName =
				sessionData.user?.name ?? sessionData.user?.email ?? serverUrl;
			console.log(`✓ Logged in as ${displayName}`);
			return;
		}

		switch (tokenData.error) {
			case 'authorization_pending':
				continue;
			case 'slow_down':
				interval *= 2;
				continue;
			case 'expired_token':
				throw new Error('Device code expired — please run login again');
			case 'access_denied':
				throw new Error('Authorization denied — you rejected the request');
			default:
				throw new Error(tokenData.error_description ?? tokenData.error);
		}
	}
}
