/**
 * RFC 8628 Device Authorization Grant flow.
 *
 * Used for headless/CLI auth where a browser-based login is required.
 * The user visits a URL, enters a code, and the CLI polls until approved.
 *
 * Moved from `apps/runner/src/auth.ts`.
 */

import { type AuthSession, saveSession } from './store';

const CLIENT_ID = 'epicenter-runner';

/**
 * Create an API client bound to a specific Epicenter server.
 *
 * Closes over `serverUrl` so callers don't repeat it on every request.
 */
function createServerApi(serverUrl: string) {
	async function post(path: string, body: Record<string, string>) {
		const res = await fetch(`${serverUrl}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		const text = await res.text();
		if (!text) {
			throw new Error(
				`POST ${path} failed: server returned ${res.status} with no body`,
			);
		}

		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new Error(
				`POST ${path} failed (${res.status}): ${text.slice(0, 200)}`,
			);
		}
	}

	return {
		/**
		 * Request a device code for the OAuth device authorization flow.
		 *
		 * Throws if the server returns an error (e.g. invalid client) so the
		 * caller only sees a validated response with the expected fields.
		 */
		async requestDeviceCode() {
			const data = await post('/auth/device/code', { client_id: CLIENT_ID });
			if (data.error) {
				throw new Error(
					(data.error_description as string) ??
						`Device code request failed: ${data.error}`,
				);
			}
			return data;
		},

		/** Poll the token endpoint with a previously-issued device code. */
		pollDeviceToken(deviceCode: string) {
			return post('/auth/device/token', {
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: deviceCode,
				client_id: CLIENT_ID,
			});
		},
	};
}

/**
 * Authenticate with an Epicenter server using the RFC 8628 device code flow.
 *
 * Initiates a device authorization request, prints the verification URL and user code,
 * then polls until the user completes authorization or the request expires.
 * On success, saves the session to the unified auth store.
 */
export async function loginWithDeviceCode(
	serverUrl: string,
	home: string,
): Promise<void> {
	const api = createServerApi(serverUrl);
	const codeData = await api.requestDeviceCode();

	console.log(`\nVisit: ${codeData.verification_uri_complete}`);
	console.log(`Enter code: ${codeData.user_code}\n`);

	let interval = (codeData.interval as number) * 1000;

	while (true) {
		await Bun.sleep(interval);

		const tokenData = await api.pollDeviceToken(codeData.device_code as string);

		if (!tokenData.error) {
			const accessToken = tokenData.access_token as string;

			// Fetch user info with the new token
			let user: AuthSession['user'];
			try {
				const sessionRes = await fetch(`${serverUrl}/auth/get-session`, {
					headers: { authorization: `Bearer ${accessToken}` },
				});
				if (sessionRes.ok) {
					const sessionData = (await sessionRes.json()) as {
						user?: { id: string; email: string; name?: string };
					};
					user = sessionData.user;
				}
			} catch {
				// Non-fatal — we still have the token
			}

			const session: AuthSession = {
				server: serverUrl,
				accessToken,
				createdAt: Date.now(),
				expiresIn: tokenData.expires_in as number,
				user,
			};

			await saveSession(home, session);
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
					(tokenData.error_description as string) ??
						(tokenData.error as string),
				);
		}
	}
}
