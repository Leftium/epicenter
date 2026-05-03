/**
 * Machine Auth Tests
 *
 * Verifies the Node-side device-code coordinator and keychain serialization
 * used by CLI and machine processes.
 *
 * Key behaviors:
 * - Device login stores the normalized `AuthSession`
 * - Status refreshes rotated authorization tokens
 * - Keychain storage persists one AuthSession value
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { Ok } from 'wellcrafted/result';
import type { AuthSession } from '../auth-types.js';
import type { BetterAuthSessionResponse } from '../contracts/auth-session.js';
import {
	createKeychainMachineAuthStorage,
	createMachineAuth,
	type MachineAuthStorage,
	type MachineAuthStorageBackend,
} from './machine-auth.js';
import { createMachineAuthTransport } from './machine-auth-transport.js';

const encryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] satisfies AuthSession['encryptionKeys'];

function makeSession({
	token = 'authorization-token',
}: {
	token?: string;
} = {}): AuthSession {
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

/**
 * In-memory storage for coordinator tests. Plain `load` / `save` over a single
 * cell; production callers use `createKeychainMachineAuthStorage`.
 */
function makeMemoryStorage(
	initial: AuthSession | null = null,
): MachineAuthStorage & { peek(): AuthSession | null } {
	let current = initial;
	return {
		async load() {
			return Ok(current);
		},
		async save(session) {
			current = session;
			return Ok(undefined);
		},
		peek() {
			return current;
		},
	};
}

function makeMemoryKeychainBackend(): MachineAuthStorageBackend & {
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
		async set(options, value) {
			values.set(key(options), value);
		},
		async delete(options) {
			values.delete(key(options));
		},
	};
}

let storage: ReturnType<typeof makeMemoryStorage>;

beforeEach(() => {
	storage = makeMemoryStorage();
});

function createTestMachineAuth(fetchImpl: typeof fetch) {
	return createMachineAuth({
		transport: createMachineAuthTransport({ fetch: fetchImpl }),
		storage,
		sleep: async () => {},
	});
}

describe('createMachineAuth', () => {
	test('login stores one AuthSession using the authorization token', async () => {
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

		const result = await createTestMachineAuth(fetchImpl).loginWithDeviceCode();

		expect(result.error).toBeNull();
		expect(result.data?.session.user.email).toBe('user@example.com');
		expect(storage.peek()?.token).toBe('rotated-authorization-token');
		expect(JSON.stringify(storage.peek())).not.toContain('server-session-token');
	});

	test('status verifies and refreshes the stored session token', async () => {
		await storage.save(makeSession({ token: 'old-token' }));
		const seenTokens: string[] = [];
		const fetchImpl = (async (_input, init) => {
			seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
			return jsonResponse(makeBetterAuthSessionResponse(), {
				headers: { 'set-auth-token': 'new-token' },
			});
		}) as typeof fetch;

		const result = await createTestMachineAuth(fetchImpl).status();

		expect(result.error).toBeNull();
		expect(result.data?.status).toBe('valid');
		expect(seenTokens).toEqual(['Bearer old-token']);
		expect(storage.peek()?.token).toBe('new-token');
	});

	test('status reports stored session when remote verification fails', async () => {
		await storage.save(makeSession());
		const fetchImpl = (async () =>
			new Response('nope', { status: 503 })) as unknown as typeof fetch;

		const result = await createTestMachineAuth(fetchImpl).status();

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

		const result = await createTestMachineAuth(fetchImpl).loginWithDeviceCode();

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('DeviceCodeExpired');
	});

	test('logout signs out and clears the stored session', async () => {
		await storage.save(makeSession({ token: 'logout-token' }));
		const seenTokens: string[] = [];
		const fetchImpl = (async (_input, init) => {
			seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
			return new Response('', { status: 200 });
		}) as typeof fetch;

		const result = await createTestMachineAuth(fetchImpl).logout();

		expect(result).toEqual({ data: { status: 'loggedOut' }, error: null });
		expect(seenTokens).toEqual(['Bearer logout-token']);
		expect(storage.peek()).toBeNull();
	});

	test('getEncryptionKeys returns the stored keys', async () => {
		await storage.save(makeSession({ token: 'stored-token' }));
		const machineAuth = createTestMachineAuth(fetch);

		expect(await machineAuth.getEncryptionKeys()).toEqual({
			data: encryptionKeys,
			error: null,
		});
	});

	test('getEncryptionKeys returns Ok(null) for absent sessions', async () => {
		const result = await createTestMachineAuth(fetch).getEncryptionKeys();

		expect(result).toEqual({ data: null, error: null });
	});
});

describe('keychain machine session storage', () => {
	test('keychain storage writes one AuthSession item', async () => {
		const backend = makeMemoryKeychainBackend();
		const keychain = createKeychainMachineAuthStorage({ backend });

		await keychain.save(makeSession({ token: 'stored-token' }));

		expect(backend.values.size).toBe(1);
		const { data: loaded } = await keychain.load();
		expect(loaded).toMatchObject({ token: 'stored-token' });
		expect([...backend.values.values()][0]).not.toContain(
			'server-session-token',
		);
	});

	test('keychain storage discards a corrupt blob and returns Ok(null)', async () => {
		const backend = makeMemoryKeychainBackend();
		backend.values.set('epicenter.auth.session:current', '{not valid json');
		const keychain = createKeychainMachineAuthStorage({ backend });

		const { data, error } = await keychain.load();

		expect(error).toBeNull();
		expect(data).toBeNull();
	});
});
