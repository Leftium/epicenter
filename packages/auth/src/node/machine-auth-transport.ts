import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { type } from 'arktype';
import type { AuthSession } from '../auth-types.js';
import { normalizeAuthSession } from '../contracts/auth-session.js';

const MachineAuthTransportDeviceCodeResponse = type({
	device_code: 'string',
	user_code: 'string',
	verification_uri: 'string',
	verification_uri_complete: 'string',
	expires_in: 'number',
	interval: 'number',
});
type MachineAuthTransportDeviceCodeResponse =
	typeof MachineAuthTransportDeviceCodeResponse.infer;

const MachineAuthTransportDeviceTokenSuccessResponse = type({
	access_token: 'string',
	expires_in: 'number',
	'token_type?': 'string',
	'error?': 'undefined',
});

const MachineAuthTransportDeviceTokenErrorResponse = type({
	error: 'string',
	'error_description?': 'string',
});

const MachineAuthTransportDeviceTokenResponse =
	MachineAuthTransportDeviceTokenSuccessResponse.or(
		MachineAuthTransportDeviceTokenErrorResponse,
	);
type MachineAuthTransportDeviceTokenResponse =
	typeof MachineAuthTransportDeviceTokenResponse.infer;

type MachineAuthTransportSessionResult = {
	session: AuthSession;
};

export type MachineAuthTransport = ReturnType<
	typeof createMachineAuthTransport
>;

/**
 * Create the small first-party HTTP transport used by machine auth.
 *
 * This layer owns raw server-response parsing and token header policy. It
 * normalizes `/auth/get-session` into `AuthSession` immediately so callers do
 * not have to reason about Better Auth's `{ user, session }` response shape or
 * the `set-auth-token` fallback. The API origin comes from
 * `@epicenter/constants`; machine auth no longer accepts per-call server
 * origins.
 *
 * The `client_id` value comes from `@epicenter/constants/oauth` so the CLI
 * device flow and API trusted-client registration cannot drift.
 */
export function createMachineAuthTransport({
	fetch: fetchImpl = fetch,
}: {
	fetch?: typeof globalThis.fetch;
} = {}) {
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

		const response = await fetchImpl(`${EPICENTER_API_URL}${path}`, {
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
		async requestDeviceCode(): Promise<MachineAuthTransportDeviceCodeResponse> {
			const { data } = await requestJson({
				method: 'POST',
				path: '/auth/device/code',
				body: { client_id: EPICENTER_CLI_OAUTH_CLIENT_ID },
			});
			return MachineAuthTransportDeviceCodeResponse.assert(data);
		},

		async pollDeviceToken({
			deviceCode,
		}: {
			deviceCode: string;
		}): Promise<MachineAuthTransportDeviceTokenResponse> {
			const response = await fetchImpl(
				`${EPICENTER_API_URL}/auth/device/token`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						device_code: deviceCode,
						client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
					}),
				},
			);
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
				return MachineAuthTransportDeviceTokenResponse.assert(data);
			}
			if (response.status === 400 && data !== undefined) {
				return MachineAuthTransportDeviceTokenErrorResponse.assert(data);
			}
			throw new Error(
				`POST /auth/device/token failed (${response.status}): ${text.slice(0, 200)}`,
			);
		},

		async fetchSession({
			token,
		}: {
			token: string;
		}): Promise<MachineAuthTransportSessionResult> {
			const { data, response } = await requestJson({
				method: 'GET',
				path: '/auth/get-session',
				token,
			});
			return {
				session: normalizeAuthSession(data, {
					token: response.headers.get('set-auth-token') ?? token,
				}),
			};
		},

		async signOut({ token }: { token: string }): Promise<void> {
			await fetchImpl(`${EPICENTER_API_URL}/auth/sign-out`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			});
		},
	};
}
