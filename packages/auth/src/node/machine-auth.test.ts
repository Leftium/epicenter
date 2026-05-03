import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthSession } from '../auth-types.js';
import type { BetterAuthSessionResponse } from '../contracts/auth-session.js';
import {
	createKeychainMachineAuthSessionStorage,
	createMachineAuth,
	createMachineAuthClient,
	createMachineSessionStorage,
	createMemoryMachineAuthSessionStorage,
	type MachineAuthSessionStorageBackend,
} from './machine-auth.js';

const EPICENTER_API_URL = 'https://api.epicenter.so';

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

function memoryBackend(): MachineAuthSessionStorageBackend & {
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

let sessionStorage: ReturnType<typeof createMemoryMachineAuthSessionStorage>;

beforeEach(() => {
	sessionStorage = createMemoryMachineAuthSessionStorage();
});

function createTestMachineAuth(fetchImpl: typeof fetch) {
	return createMachineAuth({
		fetch: fetchImpl,
		sessionStorage,
		sleep: async () => {},
	});
}

describe('createMachineAuth', () => {
	test('login stores one AuthSession using the authorization token', async () => {
		const fetchImpl = (async (input) => {
			const url = new URL(String(input));
			expect(url.origin).toBe(EPICENTER_API_URL);
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
			if (url.pathname === '/auth/device/token') {
				return jsonResponse({ access_token: 'device-token', expires_in: 3600 });
			}
			return jsonResponse(makeBetterAuthSessionResponse(), {
				headers: { 'set-auth-token': 'rotated-authorization-token' },
			});
		}) as typeof fetch;

		const result = await createTestMachineAuth(fetchImpl).loginWithDeviceCode();
		const stored = await sessionStorage.load();

		expect(result.error).toBeNull();
		expect(result.data?.session.user.email).toBe('user@example.com');
		expect(stored?.token).toBe('rotated-authorization-token');
		expect(JSON.stringify(stored)).not.toContain('server-session-token');
	});

	test('status verifies and refreshes the stored session token', async () => {
		await sessionStorage.save(makeSession({ token: 'old-token' }));
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
		expect((await sessionStorage.load())?.token).toBe('new-token');
	});

	test('status reports stored session when remote verification fails', async () => {
		await sessionStorage.save(makeSession());
		const fetchImpl = (async () =>
			new Response('nope', { status: 503 })) as unknown as typeof fetch;

		const result = await createTestMachineAuth(fetchImpl).status();

		expect(result.error).toBeNull();
		expect(result.data?.status).toBe('unverified');
	});

	test('logout signs out and clears the stored session', async () => {
		await sessionStorage.save(makeSession({ token: 'logout-token' }));
		const seenTokens: string[] = [];
		const fetchImpl = (async (_input, init) => {
			seenTokens.push(new Headers(init?.headers).get('authorization') ?? '');
			return new Response('', { status: 200 });
		}) as typeof fetch;

		const result = await createTestMachineAuth(fetchImpl).logout();

		expect(result).toEqual({ data: { status: 'loggedOut' }, error: null });
		expect(seenTokens).toEqual(['Bearer logout-token']);
		expect(await sessionStorage.load()).toBeNull();
	});

	test('direct readers return the stored token and encryption keys', async () => {
		await sessionStorage.save(makeSession({ token: 'stored-token' }));
		const machineAuth = createTestMachineAuth(fetch);

		expect(await machineAuth.getAuthorizationToken()).toEqual({
			data: 'stored-token',
			error: null,
		});
		expect(await machineAuth.getEncryptionKeys()).toEqual({
			data: encryptionKeys,
			error: null,
		});
	});

	test('direct readers return Ok(null) for absent sessions', async () => {
		const result = await createTestMachineAuth(fetch).getAuthorizationToken();

		expect(result).toEqual({ data: null, error: null });
	});
});

describe('machine session storage', () => {
	test('keychain storage writes one AuthSession item', async () => {
		const backend = memoryBackend();
		const storage = createKeychainMachineAuthSessionStorage({ backend });

		await storage.save(makeSession({ token: 'stored-token' }));

		expect(backend.values.size).toBe(1);
		expect(await storage.load()).toMatchObject({ token: 'stored-token' });
		expect([...backend.values.values()][0]).not.toContain('serverSession');
	});

	test('createMachineSessionStorage bridges MachineAuth load and save', async () => {
		const machineAuth = createTestMachineAuth(fetch);
		const storage = createMachineSessionStorage({ machineAuth });

		await expect(storage.load()).resolves.toBeNull();
		await storage.save(makeSession({ token: 'saved-token' }));

		expect((await machineAuth.loadSession()).data?.token).toBe('saved-token');
	});

	test('machine auth client hydrates from machine session storage', async () => {
		await sessionStorage.save(makeSession({ token: 'authorization-token' }));

		const auth = createMachineAuthClient({
			machineAuth: createTestMachineAuth(fetch),
		});
		await auth.whenLoaded;

		expect(auth.snapshot).toMatchObject({
			status: 'signedIn',
			session: { token: 'authorization-token' },
		});
		auth[Symbol.dispose]();
	});
});
