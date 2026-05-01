import {
	normalizeSessionResponse,
	type Session,
} from '../contracts/session.js';
import { type } from 'arktype';
import { normalizeServerOrigin } from './server-origin.js';

export const DeviceCodeResponse = type({
	device_code: 'string',
	user_code: 'string',
	verification_uri: 'string',
	verification_uri_complete: 'string',
	expires_in: 'number',
	interval: 'number',
});
export type DeviceCodeResponse = typeof DeviceCodeResponse.infer;

const DeviceTokenSuccessResponse = type({
	access_token: 'string',
	expires_in: 'number',
	'token_type?': 'string',
	'error?': 'undefined',
});

const DeviceTokenErrorResponse = type({
	error: 'string',
	'error_description?': 'string',
});

export const DeviceTokenResponse = DeviceTokenSuccessResponse.or(
	DeviceTokenErrorResponse,
);
export type DeviceTokenResponse = typeof DeviceTokenResponse.infer;

export type AuthServerCredentialSession = {
	bearerToken: string;
	session: Session;
};

export type AuthServerClient = ReturnType<typeof createAuthServerClient>;

export function createAuthServerClient(
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
		}): Promise<DeviceCodeResponse> {
			const { data } = await requestJson({
				method: 'POST',
				path: '/auth/device/code',
				body: { client_id: clientId },
			});
			return DeviceCodeResponse.assert(data);
		},

		async pollDeviceToken({
			deviceCode,
			clientId,
		}: {
			deviceCode: string;
			clientId: string;
		}): Promise<DeviceTokenResponse> {
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
				return DeviceTokenResponse.assert(data);
			}
			if (response.status === 400 && data !== undefined) {
				return DeviceTokenErrorResponse.assert(data);
			}
			throw new Error(
				`POST /auth/device/token failed (${response.status}): ${text.slice(0, 200)}`,
			);
		},

		async fetchCredentialSession({
			bearerToken,
		}: {
			bearerToken: string;
		}): Promise<AuthServerCredentialSession> {
			const { data, response } = await requestJson({
				method: 'GET',
				path: '/auth/get-session',
				token: bearerToken,
			});
			return {
				bearerToken: response.headers.get('set-auth-token') ?? bearerToken,
				session: normalizeSessionResponse(data),
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
