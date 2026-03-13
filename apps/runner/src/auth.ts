import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const CLIENT_ID = 'epicenter-runner';

type StoredToken = {
	access_token: string;
	server: string;
	created_at: number;
	expires_in: number;
};

// ─── Server API ────────────────────────────────────────────────────────────────────

/**
 * Create an API client bound to a specific Epicenter server.
 *
 * Closes over `serverUrl` so callers don't repeat it on every request.
 * `post` is a private helper; only the named operations are exposed.
 */
function createServerApi(serverUrl: string) {
	async function post(path: string, body: Record<string, string>) {
		const res = await fetch(`${serverUrl}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return res.json() as Promise<Record<string, unknown>>;
	}

	return {
		/** Request a device code for the OAuth device authorization flow. */
		requestDeviceCode() {
			return post('/auth/device/code', { client_id: CLIENT_ID });
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
 * On success, writes the token to `{configDir}/.epicenter/auth/token.json`.
 */
export async function login(
	serverUrl: string,
	configDir: string,
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
			const authDir = join(configDir, '.epicenter', 'auth');
			await mkdir(authDir, { recursive: true });

			const stored: StoredToken = {
				access_token: tokenData.access_token as string,
				server: serverUrl,
				created_at: Date.now(),
				expires_in: tokenData.expires_in as number,
			};
			await Bun.write(
				join(authDir, 'token.json'),
				JSON.stringify(stored, null, '\t'),
			);

			console.log(`✓ Logged in to ${serverUrl}`);
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
				throw new Error((tokenData.error_description as string) ?? (tokenData.error as string));
		}
	}
}

/**
 * Delete the stored auth token. No-op if no token exists.
 */
export async function logout(configDir: string): Promise<void> {
	try {
		await unlink(join(configDir, '.epicenter', 'auth', 'token.json'));
	} catch {
		// No-op — file doesn't exist
	}
	console.log('✓ Logged out');
}

/**
 * Resolve an auth token for the sync extension.
 *
 * Resolution order:
 * 1. `EPICENTER_TOKEN` env var (override for CI/scripts)
 * 2. Stored token file at `{configDir}/.epicenter/auth/token.json`
 * 3. `undefined` (unauthenticated)
 *
 * Called on each WebSocket reconnect so a freshly-minted token from
 * `login` in another terminal is picked up without restarting the runner.
 */
export async function loadToken(
	configDir: string,
): Promise<string | undefined> {
	if (process.env.EPICENTER_TOKEN) return process.env.EPICENTER_TOKEN;

	const tokenFile = Bun.file(
		join(configDir, '.epicenter', 'auth', 'token.json'),
	);
	if (await tokenFile.exists()) {
		const stored: StoredToken = await tokenFile.json();
		return stored.access_token;
	}

	return undefined;
}
