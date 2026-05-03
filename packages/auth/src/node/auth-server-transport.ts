import { type } from 'arktype';
import type { AuthSession } from '../auth-types.js';
import { normalizeAuthSession } from '../contracts/auth-session.js';
import { normalizeServerOrigin } from './server-origin.js';

const AuthServerTransportDeviceCodeResponse = type({
	device_code: 'string',
	user_code: 'string',
	verification_uri: 'string',
	verification_uri_complete: 'string',
	expires_in: 'number',
	interval: 'number',
});
type AuthServerTransportDeviceCodeResponse =
	typeof AuthServerTransportDeviceCodeResponse.infer;

const AuthServerTransportDeviceTokenSuccessResponse = type({
	access_token: 'string',
	expires_in: 'number',
	'token_type?': 'string',
	'error?': 'undefined',
});

const AuthServerTransportDeviceTokenErrorResponse = type({
	error: 'string',
	'error_description?': 'string',
});

const AuthServerTransportDeviceTokenResponse =
	AuthServerTransportDeviceTokenSuccessResponse.or(
		AuthServerTransportDeviceTokenErrorResponse,
	);
type AuthServerTransportDeviceTokenResponse =
	typeof AuthServerTransportDeviceTokenResponse.infer;

type AuthServerTransportSessionResult = {
	session: AuthSession;
};

export type AuthServerTransport = ReturnType<typeof createAuthServerTransport>;

/**
 * Create the small HTTP transport used by machine auth.
 *
 * This layer owns raw server-response parsing and token header policy. It
 * normalizes `/auth/get-session` into `AuthSession` immediately so callers do
 * not have to reason about Better Auth's `{ user, session }` response shape or
 * the `set-auth-token` fallback.
 *
 * @example
 * ```ts
 * const transport = createAuthServerTransport(
 * 	{ fetch },
 * 	{ serverOrigin: 'https://api.epicenter.so' },
 * );
 * ```
 */
export function createAuthServerTransport(
	{ fetch }: { fetch: typeof globalThis.fetch },
	{ serverOrigin }: { serverOrigin: string },
) {
	const origin = normalizeServerOrigin(serverOrigin);

	async function requestJson({
		method,
		path,
		body,
		token,
	}: {
		method: string;
		path: string;
		body?: unknown;
		token?: string;
	}): Promise<{ data: unknown; response: Response }> {
		const headers: Record<string, string> = {};
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		if (body !== undefined) headers['content-type'] = 'application/json';

		const response = await fetch(`${origin}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await response.text();

		if (!response.ok) {
			throw new Error(
				`${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`,
			);
		}
		if (!text) throw new Error(`${method} ${path}: empty response body`);

		try {
			return { data: JSON.parse(text), response };
		} catch {
			throw new Error(
				`${method} ${path}: invalid JSON response: ${text.slice(0, 200)}`,
			);
		}
	}

	return {
		serverOrigin: origin,

		async requestDeviceCode({
			clientId,
		}: {
			clientId: string;
		}): Promise<AuthServerTransportDeviceCodeResponse> {
			const { data } = await requestJson({
				method: 'POST',
				path: '/auth/device/code',
				body: { client_id: clientId },
			});
			return AuthServerTransportDeviceCodeResponse.assert(data);
		},

		async pollDeviceToken({
			deviceCode,
			clientId,
		}: {
			deviceCode: string;
			clientId: string;
		}): Promise<AuthServerTransportDeviceTokenResponse> {
			const response = await fetch(`${origin}/auth/device/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					device_code: deviceCode,
					client_id: clientId,
				}),
			});
			const text = await response.text();
			let data: unknown;

			if (text) {
				try {
					data = JSON.parse(text);
				} catch {
					throw new Error(
						`POST /auth/device/token: invalid JSON response: ${text.slice(0, 200)}`,
					);
				}
			}

			if (response.ok && data !== undefined) {
				return AuthServerTransportDeviceTokenResponse.assert(data);
			}
			if (response.status === 400 && data !== undefined) {
				return AuthServerTransportDeviceTokenErrorResponse.assert(data);
			}
			throw new Error(
				`POST /auth/device/token failed (${response.status}): ${text.slice(0, 200)}`,
			);
		},

		async fetchSession({
			authorizationToken,
		}: {
			authorizationToken: string;
		}): Promise<AuthServerTransportSessionResult> {
			const { data, response } = await requestJson({
				method: 'GET',
				path: '/auth/get-session',
				token: authorizationToken,
			});
			return {
				session: normalizeAuthSession(data, {
					token: response.headers.get('set-auth-token') ?? authorizationToken,
				}),
			};
		},

		async signOut({ token }: { token: string }): Promise<void> {
			await fetch(`${origin}/auth/sign-out`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			});
		},
	};
}
