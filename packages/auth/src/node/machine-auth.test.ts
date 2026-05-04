/**
 * Machine Auth Tests
 *
 * Verifies the Node-side device-code coordinator and keychain serialization
 * used by CLI and machine processes.
 *
 * Key behaviors:
 * - Device login stores the normalized `BearerSession`
 * - Status refreshes rotated authorization tokens
 * - Keychain storage persists one BearerSession value
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import {
	createLogger,
	memorySink,
	type Logger,
} from 'wellcrafted/logger';
import type { BearerSession } from '../auth-types.js';
import type { BetterAuthSessionResponse } from '../contracts/auth-session.js';
import {
	loginWithDeviceCode,
	logout,
	status,
} from './machine-auth.js';
import {
	createMachineAuthTransport,
	type DeviceTokenError,
	type MachineAuthRequestError,
} from './machine-auth-transport.js';
import {
	loadMachineSession,
	saveMachineSession,
	type MachineAuthStorageError,
} from './machine-session-store.js';

type Expect<TValue extends true> = TValue;
type Equal<TActual, TExpected> =
	(<TValue>() => TValue extends TActual ? 1 : 2) extends <
		TValue,
	>() => TValue extends TExpected ? 1 : 2
		? true
		: false;
type ResultError<TValue extends { data: unknown; error: unknown }> = Extract<
	TValue,
	{ data: null }
>['error'];

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

type MachineSessionOptions = NonNullable<
	Parameters<typeof loadMachineSession>[0]
>;
type MachineSessionBackend = NonNullable<MachineSessionOptions['backend']>;

const encryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] satisfies BearerSession['encryptionKeys'];

function makeSession({
	token = 'authorization-token',
}: {
	token?: string;
} = {}): BearerSession {
	return {
		token,
		user: {
			id: 'user-1',
			name: 'User One',
			email: 'user@example.com',
			emailVerified: true,
			image: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		encryptionKeys: [...encryptionKeys],
	};
}

function makeBetterAuthSessionResponse({
	sessionToken = 'server-session-token',
}: {
	sessionToken?: string;
} = {}): BetterAuthSessionResponse {
	const session = makeSession();
	return {
		user: {
			...session.user,
			createdAt: new Date(session.user.createdAt),
			updatedAt: new Date(session.user.updatedAt),
		},
		session: {
			id: 'session-1',
			token: sessionToken,
			userId: session.user.id,
			expiresAt: new Date('2026-02-01T00:00:00.000Z'),
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			ipAddress: null,
			userAgent: null,
		},
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

function makeMemoryKeychainBackend(): MachineSessionBackend & {
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

let backend: ReturnType<typeof makeMemoryKeychainBackend>;
let log: Logger;

beforeEach(() => {
	backend = makeMemoryKeychainBackend();
	const { sink } = memorySink();
	log = createLogger('machine-auth-test', sink);
});

function makeTestTransport(fetchImpl: typeof fetch) {
	return createMachineAuthTransport({ fetch: fetchImpl });
}

async function peekMachineSession() {
	const { data, error } = await loadMachineSession({ backend, log });
	if (error) throw error;
	return data;
}

describe('machine auth free functions', () => {
	test('login stores one BearerSession using the authorization token', async () => {
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
				return jsonResponse({ access_token: 'device-token', expires_in: 3600 });
			}
			return jsonResponse(makeBetterAuthSessionResponse(), {
				headers: { 'set-auth-token': 'rotated-authorization-token' },
			});
		}) as typeof fetch;

		const result = await loginWithDeviceCode({
			transport: makeTestTransport(fetchImpl),
			backend,
			sleep: async () => {},
		});

		const savedSession = await peekMachineSession();
		expect(result.error).toBeNull();
		expect(result.data?.session.user.email).toBe('user@example.com');
		expect(savedSession?.token).toBe('rotated-authorization-token');
		expect(JSON.stringify(savedSession)).not.toContain('server-session-token');
	});

	test('status verifies and refreshes the stored session token', async () => {
		await saveMachineSession(makeSession({ token: 'old-token' }), { backend });
		const seenTokens: string[] = [];
		const fetchImpl = (async (_input, init) => {
			seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
			return jsonResponse(makeBetterAuthSessionResponse(), {
				headers: { 'set-auth-token': 'new-token' },
			});
		}) as typeof fetch;

		const result = await status({
			transport: makeTestTransport(fetchImpl),
			backend,
			log,
		});

		expect(result.error).toBeNull();
		expect(result.data?.status).toBe('valid');
		expect(seenTokens).toEqual(['Bearer old-token']);
		expect((await peekMachineSession())?.token).toBe('new-token');
	});

	test('status reports stored session when remote verification fails', async () => {
		await saveMachineSession(makeSession(), { backend });
		const fetchImpl = (async () =>
			new Response('nope', { status: 503 })) as unknown as typeof fetch;

		const result = await status({
			transport: makeTestTransport(fetchImpl),
			backend,
			log,
		});

		expect(result.error).toBeNull();
		expect(result.data?.status).toBe('unverified');
	});

	test('login returns DeviceCodeExpired when the server reports expired_token', async () => {
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
			transport: makeTestTransport(fetchImpl),
			backend,
			sleep: async () => {},
		});

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('DeviceCodeExpired');
	});

	test('logout signs out and clears the stored session', async () => {
		await saveMachineSession(makeSession({ token: 'logout-token' }), { backend });
		const seenTokens: string[] = [];
		const fetchImpl = (async (_input, init) => {
			seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
			return new Response('', { status: 200 });
		}) as typeof fetch;

		const result = await logout({
			transport: makeTestTransport(fetchImpl),
			backend,
			log,
		});

		expect(result).toEqual({ data: { status: 'loggedOut' }, error: null });
		expect(seenTokens).toEqual(['Bearer logout-token']);
		expect(await peekMachineSession()).toBeNull();
	});
});

describe('machine session storage', () => {
	test('keychain storage writes one BearerSession item', async () => {
		await saveMachineSession(makeSession({ token: 'stored-token' }), {
			backend,
		});

		expect(backend.values.size).toBe(1);
		const { data: loaded } = await loadMachineSession({ backend, log });
		expect(loaded).toMatchObject({ token: 'stored-token' });
		expect([...backend.values.values()][0]).not.toContain(
			'server-session-token',
		);
	});

	test('keychain storage discards a corrupt blob and returns Ok(null)', async () => {
		backend.values.set('epicenter.auth.session:current', '{not valid json');

		const { data, error } = await loadMachineSession({ backend, log });

		expect(error).toBeNull();
		expect(data).toBeNull();
	});
});
