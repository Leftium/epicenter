/**
 * Machine Auth Tests
 *
 * Verifies the Node-side device-code coordinator and keychain serialization
 * used by CLI and machine processes.
 *
 * Key behaviors:
 * - Device login stores the normalized `OAuthSession`
 * - Status refreshes rotated access tokens
 * - Keychain storage persists one OAuthSession value
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { createLogger, type Logger, memorySink } from 'wellcrafted/logger';
import type { WorkspaceIdentity, OAuthSession } from '../auth-types.js';
import {
	createMachineAuthClient,
	type DeviceTokenError,
	loginWithDeviceCode,
	logout,
	type MachineAuthClient,
	type MachineAuthRequestError,
	status,
} from './machine-auth.js';
import {
	loadMachineSession,
	type MachineAuthStorageError,
	saveMachineSession,
} from './machine-session-store.js';

type Expect<TValue extends true> = TValue;
type Equal<TActual, TExpected> =
	(<TValue>() => TValue extends TActual ? 1 : 2) extends <
		TValue,
	>() => TValue extends TExpected ? 1 : 2
		? true
		: false;
type ResultError<TValue extends { error: unknown }> = NonNullable<
	TValue['error']
>;
export type LoginWithDeviceCodeError = Expect<
	Equal<
		ResultError<Awaited<ReturnType<typeof loginWithDeviceCode>>>,
		MachineAuthRequestError | DeviceTokenError | MachineAuthStorageError
	>
>;
export type StatusError = Expect<
	Equal<
		ResultError<Awaited<ReturnType<typeof status>>>,
		MachineAuthStorageError
	>
>;
export type LogoutError = Expect<
	Equal<
		ResultError<Awaited<ReturnType<typeof logout>>>,
		MachineAuthStorageError
	>
>;

const encryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] satisfies OAuthSession['encryptionKeys'];

function makeSession({
	accessToken = 'authorization-token',
	accessTokenExpiresAt = Date.now() + 3_600_000,
}: {
	accessToken?: string;
	accessTokenExpiresAt?: number;
} = {}): OAuthSession {
	return {
		accessToken,
		refreshToken: 'refresh-token',
		accessTokenExpiresAt,
		user: {
			id: 'user-1',
			name: 'User One',
			email: 'user@example.com',
		},
		encryptionKeys: [...encryptionKeys],
	};
}

function makeAuthIdentity(): WorkspaceIdentity {
	const session = makeSession();
	return {
		user: session.user,
		encryptionKeys: session.encryptionKeys,
	};
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		...init,
		headers: {
			'content-type': 'application/json',
			...init?.headers,
		},
	});
}

function makeTestAuthClient(fetchImpl: typeof globalThis.fetch) {
	return {
		deviceCode: (body: unknown) =>
			callFakeAuth(fetchImpl, '/auth/device/code', {
				method: 'POST',
				body,
			}),
		deviceToken: (body: unknown) =>
			callFakeAuth(fetchImpl, '/auth/device/token', {
				method: 'POST',
				body,
			}),
		getSession: (input?: {
			fetchOptions?: {
				headers?: RequestInit['headers'];
				onSuccess?: (context: { response: Response }) => void;
			};
		}) =>
			callFakeAuth(fetchImpl, '/auth/get-session', {
				method: 'GET',
				fetchOptions: input?.fetchOptions,
			}),
		signOut: (input?: {
			fetchOptions?: {
				headers?: RequestInit['headers'];
			};
		}) =>
			callFakeAuth(fetchImpl, '/auth/sign-out', {
				method: 'POST',
				body: {},
				fetchOptions: input?.fetchOptions,
			}),
	} as unknown as MachineAuthClient;
}

async function callFakeAuth(
	fetchImpl: typeof globalThis.fetch,
	path: string,
	{
		method,
		body,
		fetchOptions,
	}: {
		method: string;
		body?: unknown;
		fetchOptions?: {
			headers?: RequestInit['headers'];
			onSuccess?: (context: { response: Response }) => void;
		};
	},
) {
	const headers = new Headers(fetchOptions?.headers);
	let requestBody: string | undefined;
	if (body !== undefined) {
		headers.set('content-type', 'application/json');
		requestBody = JSON.stringify(body);
	}
	const response = await fetchImpl(`${EPICENTER_API_URL}${path}`, {
		method,
		headers,
		body: requestBody,
	});
	if (response.ok) fetchOptions?.onSuccess?.({ response });
	const text = await response.text();
	let parsed: unknown = {};
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		parsed = { error: text };
	}
	if (response.ok) return { data: parsed, error: null };
	return { data: null, error: parsed };
}

function makeMemoryKeychainBackend(): typeof Bun.secrets & {
	values: Map<string, string>;
} {
	const values = new Map<string, string>();
	const key = (options: { service: string; name: string }) =>
		`${options.service}:${options.name}`;
	return {
		values,
		async get(options) {
			return values.get(key(options)) ?? null;
		},
		async set(options) {
			values.set(key(options), options.value);
		},
		async delete(options) {
			return values.delete(key(options));
		},
	};
}

let log: Logger;

beforeEach(() => {
	const { sink } = memorySink();
	log = createLogger('machine-auth-test', sink);
});

describe('machine auth free functions', () => {
	test('login stores one OAuthSession using the authorization token', async () => {
		const backend = makeMemoryKeychainBackend();
		const fetchImpl = (async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe(EPICENTER_API_URL);
			if (url.pathname === '/auth/device/code') {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
				});
				return jsonResponse({
					device_code: 'device-code',
					user_code: 'USER-CODE',
					verification_uri: `${EPICENTER_API_URL}/device`,
					verification_uri_complete: `${EPICENTER_API_URL}/device?code=USER`,
					expires_in: 600,
					interval: 0,
				});
			}
			if (url.pathname === '/auth/device/token') {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
					device_code: 'device-code',
				});
				return jsonResponse({
					access_token: 'device-token',
					refresh_token: 'device-refresh-token',
					expires_in: 3600,
				});
			}
			return jsonResponse(makeAuthIdentity(), {
				headers: { 'set-auth-token': 'rotated-authorization-token' },
			});
		}) as typeof fetch;

		const result = await loginWithDeviceCode({
			authClient: makeTestAuthClient(fetchImpl),
			backend,
			sleep: async () => {},
		});

		const { data: savedSession, error: loadError } = await loadMachineSession({
			backend,
			log,
		});
		expect(result.error).toBeNull();
		expect(loadError).toBeNull();
		expect(result.data?.session.user.email).toBe('user@example.com');
		expect(savedSession?.accessToken).toBe('rotated-authorization-token');
		expect(savedSession?.refreshToken).toBe('device-refresh-token');
		expect(JSON.stringify(savedSession)).not.toContain('session');
	});

	test('status verifies and refreshes the stored session token', async () => {
		const backend = makeMemoryKeychainBackend();
		await saveMachineSession(makeSession({ accessToken: 'old-token' }), {
			backend,
		});
		const seenTokens: string[] = [];
		const fetchImpl = (async (_input, init) => {
			seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
			return jsonResponse(makeAuthIdentity(), {
				headers: { 'set-auth-token': 'new-token' },
			});
		}) as typeof fetch;

		const result = await status({
			authClient: makeTestAuthClient(fetchImpl),
			backend,
			log,
		});

		const { data: savedSession, error: loadError } = await loadMachineSession({
			backend,
			log,
		});
		expect(result.error).toBeNull();
		expect(loadError).toBeNull();
		expect(result.data?.status).toBe('valid');
		expect(seenTokens).toEqual(['Bearer old-token']);
		expect(savedSession?.accessToken).toBe('new-token');
	});

	test('machine auth refresh pauses network auth when keychain save fails', async () => {
		const now = 1_000_000;
		const backend = makeMemoryKeychainBackend();
		await saveMachineSession(
			makeSession({
				accessToken: 'old-token',
				accessTokenExpiresAt: now + 1,
			}),
			{ backend },
		);
		backend.set = async () => {
			throw new Error('keychain unavailable');
		};
		const authorizations: Array<string | null> = [];
		const originalConsoleError = console.error;
		console.error = () => {};
		const auth = await createMachineAuthClient({
			backend,
			log,
			now: () => now,
			refreshOAuthToken: async () => ({
				accessToken: 'new-token',
				refreshToken: 'new-refresh-token',
				accessTokenExpiresAt: now + 3_600_000,
			}),
			fetch: (async (_input, init) => {
				authorizations.push(new Headers(init?.headers).get('authorization'));
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		});

		const response = await (async () => {
			try {
				return await auth.fetch(`${EPICENTER_API_URL}/resource`);
			} finally {
				console.error = originalConsoleError;
			}
		})();
		const { data: savedSession, error: loadError } = await loadMachineSession({
			backend,
			log,
		});

		expect(response.status).toBe(204);
		expect(loadError).toBeNull();
		expect(savedSession?.accessToken).toBe('old-token');
		expect(authorizations).toEqual([null]);
		expect(auth.state).toEqual({
			status: 'reauth-required',
			identity: {
				user: makeSession({ accessToken: 'old-token' }).user,
				encryptionKeys,
			},
		});
	});

	test('status reports stored session when remote verification fails', async () => {
		const backend = makeMemoryKeychainBackend();
		await saveMachineSession(makeSession(), { backend });
		const fetchImpl = (async () =>
			new Response('nope', { status: 503 })) as unknown as typeof fetch;

		const result = await status({
			authClient: makeTestAuthClient(fetchImpl),
			backend,
			log,
		});

		expect(result.error).toBeNull();
		expect(result.data?.status).toBe('unverified');
	});

	test('login returns DeviceCodeExpired when the server reports expired_token', async () => {
		const backend = makeMemoryKeychainBackend();
		const fetchImpl = (async (input) => {
			const url = new URL(String(input));
			if (url.pathname === '/auth/device/code') {
				return jsonResponse({
					device_code: 'device-code',
					user_code: 'USER-CODE',
					verification_uri: `${EPICENTER_API_URL}/device`,
					verification_uri_complete: `${EPICENTER_API_URL}/device?code=USER`,
					expires_in: 600,
					interval: 0,
				});
			}
			return new Response(JSON.stringify({ error: 'expired_token' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof fetch;

		const result = await loginWithDeviceCode({
			authClient: makeTestAuthClient(fetchImpl),
			backend,
			sleep: async () => {},
		});

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('DeviceCodeExpired');
	});

	test('logout signs out and clears the stored session', async () => {
		const backend = makeMemoryKeychainBackend();
		await saveMachineSession(makeSession({ accessToken: 'logout-token' }), {
			backend,
		});
		const seenTokens: string[] = [];
		const fetchImpl = (async (_input, init) => {
			seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
			return new Response('', { status: 200 });
		}) as typeof fetch;

		const result = await logout({
			authClient: makeTestAuthClient(fetchImpl),
			backend,
			log,
		});

		const { data: savedSession, error: loadError } = await loadMachineSession({
			backend,
			log,
		});
		expect(result).toEqual({ data: { status: 'loggedOut' }, error: null });
		expect(loadError).toBeNull();
		expect(seenTokens).toEqual(['Bearer logout-token']);
		expect(savedSession).toBeNull();
	});
});

describe('machine session storage', () => {
	test('keychain storage writes one OAuthSession item', async () => {
		const backend = makeMemoryKeychainBackend();
		await saveMachineSession(makeSession({ accessToken: 'stored-token' }), {
			backend,
		});

		expect(backend.values.size).toBe(1);
		const { data: loaded } = await loadMachineSession({ backend, log });
		expect(loaded).toMatchObject({ accessToken: 'stored-token' });
		expect([...backend.values.values()][0]).not.toContain(
			'server-session-token',
		);
	});

	test('keychain storage discards a corrupt blob and returns Ok(null)', async () => {
		const backend = makeMemoryKeychainBackend();
		backend.values.set('epicenter.auth.session:current', '{not valid json');

		const { data, error } = await loadMachineSession({ backend, log });

		expect(error).toBeNull();
		expect(data).toBeNull();
	});
});
