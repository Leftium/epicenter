import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { type } from 'arktype';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { normalizeBearerSession } from '../contracts/auth-session.js';

export const MachineAuthRequestError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthRequestError = InferErrors<
	typeof MachineAuthRequestError
>;

export const DeviceTokenError = defineErrors({
	DeviceCodeExpired: () => ({
		message: 'Device code expired. Run login again.',
	}),
	DeviceAccessDenied: () => ({
		message: 'Authorization denied.',
	}),
	DeviceAuthorizationFailed: ({
		code,
		description,
	}: {
		code: string;
		description?: string;
	}) => ({
		message: description ?? code,
		code,
		description,
	}),
});
export type DeviceTokenError = InferErrors<typeof DeviceTokenError>;

const DeviceCodeResponse = type({
	device_code: 'string',
	user_code: 'string',
	verification_uri: 'string',
	verification_uri_complete: 'string',
	expires_in: 'number',
	interval: 'number',
});
export type DeviceCodeResponse = typeof DeviceCodeResponse.infer;

const DeviceTokenSuccess = type({
	access_token: 'string',
	expires_in: 'number',
	'token_type?': 'string',
});

const DeviceTokenErrorResponse = type({
	error: 'string',
	'error_description?': 'string',
});

/**
 * Outcome of one poll of `/auth/device/token`. Terminal failures (expired,
 * denied, unknown OAuth error) surface as `Err` from `pollDeviceToken`; this
 * type only covers the in-progress states the polling loop should react to.
 */
export type DevicePollOutcome =
	| { status: 'pending' }
	| { status: 'slowDown' }
	| { status: 'success'; accessToken: string };

export type MachineAuthTransport = ReturnType<
	typeof createMachineAuthTransport
>;

/**
 * First-party HTTP transport for machine auth.
 *
 * Owns raw server-response parsing, token header policy, and OAuth-level error
 * classification. `/auth/get-session` is normalized into `BearerSession` before
 * returning so callers do not have to reason about Better Auth's
 * `{ user, session }` response shape or the `set-auth-token` fallback.
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
	}): Promise<
		Result<{ data: unknown; response: Response }, MachineAuthRequestError>
	> {
		const { data: fetched, error: fetchError } = await tryAsync({
			try: async () => {
				const headers: Record<string, string> = {};
				if (token !== undefined) headers.authorization = `Bearer ${token}`;
				if (body !== undefined) headers['content-type'] = 'application/json';
				const response = await fetchImpl(`${EPICENTER_API_URL}${path}`, {
					method,
					headers,
					body: body !== undefined ? JSON.stringify(body) : undefined,
				});
				return { response, text: await response.text() };
			},
			catch: (cause) => MachineAuthRequestError.RequestFailed({ cause }),
		});
		if (fetchError) return Err(fetchError);
		const { response, text } = fetched;

		if (!response.ok) {
			return MachineAuthRequestError.RequestFailed({
				cause: new Error(
					`${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`,
				),
			});
		}
		if (!text) {
			return MachineAuthRequestError.RequestFailed({
				cause: new Error(`${method} ${path}: empty response body`),
			});
		}
		return trySync({
			try: () => ({ data: JSON.parse(text) as unknown, response }),
			catch: (cause) =>
				MachineAuthRequestError.RequestFailed({
					cause: new Error(
						`${method} ${path}: invalid JSON response: ${text.slice(0, 200)}`,
						{ cause },
					),
				}),
		});
	}

	return {
		async requestDeviceCode() {
			const { data: response, error } = await requestJson({
				method: 'POST',
				path: '/auth/device/code',
				body: { client_id: EPICENTER_CLI_OAUTH_CLIENT_ID },
			});
			if (error) return Err(error);
			return trySync({
				try: () => DeviceCodeResponse.assert(response.data),
				catch: (cause) => MachineAuthRequestError.RequestFailed({ cause }),
			});
		},

		/**
		 * One poll of `/auth/device/token`. Returns `pending` / `slowDown` /
		 * `success` for in-progress states; expired, denied, and unknown OAuth
		 * errors surface as typed `Err` so the caller never string-matches.
		 */
		async pollDeviceToken({
			deviceCode,
		}: {
			deviceCode: string;
		}) {
			const { data: fetched, error: fetchError } = await tryAsync({
				try: async () => {
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
					return { response, text: await response.text() };
				},
				catch: (cause) => MachineAuthRequestError.RequestFailed({ cause }),
			});
			if (fetchError) return Err(fetchError);
			const { response, text } = fetched;

			if (response.ok) {
				const { data: success, error: parseError } = trySync({
					try: () => DeviceTokenSuccess.assert(JSON.parse(text)),
					catch: (cause) => MachineAuthRequestError.RequestFailed({ cause }),
				});
				if (parseError) return Err(parseError);
				return Ok({
					status: 'success' as const,
					accessToken: success.access_token,
				});
			}

			if (response.status === 400 && text) {
				const { data: parsed, error: parseError } = trySync({
					try: () => DeviceTokenErrorResponse.assert(JSON.parse(text)),
					catch: (cause) => MachineAuthRequestError.RequestFailed({ cause }),
				});
				if (parseError) return Err(parseError);
				switch (parsed.error) {
					case 'authorization_pending':
						return Ok({ status: 'pending' as const });
					case 'slow_down':
						return Ok({ status: 'slowDown' as const });
					case 'expired_token':
						return DeviceTokenError.DeviceCodeExpired();
					case 'access_denied':
						return DeviceTokenError.DeviceAccessDenied();
					default:
						return DeviceTokenError.DeviceAuthorizationFailed({
							code: parsed.error,
							description: parsed.error_description,
						});
				}
			}

			return MachineAuthRequestError.RequestFailed({
				cause: new Error(`POST /auth/device/token failed (${response.status})`),
			});
		},

		async fetchSession({
			token,
		}: {
			token: string;
		}) {
			const { data: response, error } = await requestJson({
				method: 'GET',
				path: '/auth/get-session',
				token,
			});
			if (error) return Err(error);
			return trySync({
				try: () => ({
					session: normalizeBearerSession(response.data, {
						token: response.response.headers.get('set-auth-token') ?? token,
					}),
				}),
				catch: (cause) => MachineAuthRequestError.RequestFailed({ cause }),
			});
		},

		async signOut({
			token,
		}: {
			token: string;
		}) {
			return tryAsync({
				try: async (): Promise<undefined> => {
					await fetchImpl(`${EPICENTER_API_URL}/auth/sign-out`, {
						method: 'POST',
						headers: { authorization: `Bearer ${token}` },
					});
					return undefined;
				},
				catch: (cause) => MachineAuthRequestError.RequestFailed({ cause }),
			});
		},
	};
}
