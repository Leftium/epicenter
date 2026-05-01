/**
 * Machine Auth Tests
 *
 * Verifies the clean-break Node machine auth facade over the internal
 * credential repository and auth server transport.
 *
 * Key behaviors:
 * - Status and logout use the server origin from the resolved credential
 * - Bearer token rotation never mutates the Better Auth session token
 * - Direct token and key readers distinguish absence from unsafe local state
 * - The sync token getter unwraps Ok values and throws typed errors
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { EncryptionKeys as EncryptionKeysData } from '@epicenter/workspace/encryption-key';
import type { Session } from '../contracts/session.js';
import { createMachineAuth, createMachineTokenGetter } from './machine-auth.js';
import { createMachineCredentialRepository } from './machine-credential-repository.js';
import { createPlaintextMachineCredentialSecretStorage } from './machine-credential-secret-storage.js';

const encryptionKeys: EncryptionKeysData = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

function makeSession({
	expiresAt = '2026-02-01T00:00:00.000Z',
	sessionToken = 'session-token',
}: {
	expiresAt?: string;
	sessionToken?: string;
} = {}): Session {
	return {
		user: {
			id: 'user-1',
			name: 'User One',
			email: 'user@example.com',
			emailVerified: true,
			image: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		session: {
			id: 'session-1',
			token: sessionToken,
			userId: 'user-1',
			expiresAt,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			ipAddress: null,
			userAgent: null,
		},
		encryptionKeys,
	};
}

let dir: string;
let credentialFilePath: string;

beforeEach(async () => {
	dir = await mkdtemp('/tmp/epicenter-machine-auth-test-');
	credentialFilePath = join(dir, 'credentials.json');
});

function createPlaintextMachineAuth(fetchImpl: typeof fetch) {
	return createMachineAuth({
		fetch: fetchImpl,
		credentialStorage: {
			kind: 'plaintextFile',
			credentialFilePath,
		},
		sleep: async () => {},
		clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
	});
}

function createPlaintextRepository() {
	return createMachineCredentialRepository({
		path: credentialFilePath,
		secretStorage: createPlaintextMachineCredentialSecretStorage(),
		clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
	});
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

describe('createMachineAuth', () => {
	test('status verifies against the same server origin as the resolved credential', async () => {
		const origins: string[] = [];
		const fetchImpl = (async (input) => {
			const url = new URL(String(input));
			origins.push(url.origin);
			return jsonResponse(makeSession());
		}) as typeof fetch;
		const repository = createPlaintextRepository();
		await repository.save('https://first.example.com', {
			bearerToken: 'first-token',
			session: makeSession(),
		});
		await repository.save('https://second.example.com', {
			bearerToken: 'second-token',
			session: makeSession(),
		});

		const result = await createPlaintextMachineAuth(fetchImpl).status();

		expect(result.error).toBeNull();
		expect(result.data?.status).toBe('valid');
		expect(origins).toEqual(['https://second.example.com']);
	});

	test('logout signs out against the same server origin as the resolved credential', async () => {
		const origins: string[] = [];
		const fetchImpl = (async (input) => {
			const url = new URL(String(input));
			origins.push(url.origin);
			return new Response('', { status: 200 });
		}) as typeof fetch;
		await createPlaintextRepository().save('https://logout.example.com', {
			bearerToken: 'bearer-token',
			session: makeSession(),
		});

		const result = await createPlaintextMachineAuth(fetchImpl).logout();

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			status: 'loggedOut',
			serverOrigin: 'https://logout.example.com',
		});
		expect(origins).toEqual(['https://logout.example.com']);
	});

	test('login stores set-auth-token as bearerToken without mutating session token', async () => {
		const fetchImpl = (async (input) => {
			const url = new URL(String(input));
			if (url.pathname === '/auth/device/code') {
				return jsonResponse({
					device_code: 'device-code',
					user_code: 'USER-CODE',
					verification_uri: 'https://api.epicenter.so/device',
					verification_uri_complete:
						'https://api.epicenter.so/device?code=USER',
					expires_in: 600,
					interval: 0,
				});
			}
			if (url.pathname === '/auth/device/token') {
				return jsonResponse({ access_token: 'device-token', expires_in: 3600 });
			}
			return jsonResponse(makeSession({ sessionToken: 'session-token' }), {
				headers: { 'set-auth-token': 'rotated-bearer-token' },
			});
		}) as typeof fetch;

		const result = await createPlaintextMachineAuth(
			fetchImpl,
		).loginWithDeviceCode({
			serverOrigin: 'https://api.epicenter.so',
		});
		const credential = await createPlaintextRepository().get(
			'https://api.epicenter.so',
		);

		expect(result.error).toBeNull();
		expect(credential?.bearerToken).toBe('rotated-bearer-token');
		expect(credential?.session.session.token).toBe('session-token');
	});

	test('status refresh stores set-auth-token as bearerToken without mutating session token', async () => {
		const fetchImpl = (async () =>
			jsonResponse(makeSession({ sessionToken: 'session-token' }), {
				headers: { 'set-auth-token': 'refreshed-bearer-token' },
			})) as unknown as typeof fetch;
		await createPlaintextRepository().save('https://api.epicenter.so', {
			bearerToken: 'old-bearer-token',
			session: makeSession({ sessionToken: 'session-token' }),
		});

		const result = await createPlaintextMachineAuth(fetchImpl).status({
			serverOrigin: 'https://api.epicenter.so',
		});
		const credential = await createPlaintextRepository().get(
			'https://api.epicenter.so',
		);

		expect(result.error).toBeNull();
		expect(credential?.bearerToken).toBe('refreshed-bearer-token');
		expect(credential?.session.session.token).toBe('session-token');
	});

	test('status returns Err when refresh cannot save the credential', async () => {
		const fetchImpl = (async () => {
			await Bun.write(credentialFilePath, '{not-json');
			return jsonResponse(makeSession({ sessionToken: 'session-token' }), {
				headers: { 'set-auth-token': 'refreshed-bearer-token' },
			});
		}) as unknown as typeof fetch;
		await createPlaintextRepository().save('https://api.epicenter.so', {
			bearerToken: 'old-bearer-token',
			session: makeSession({ sessionToken: 'session-token' }),
		});

		const result = await createPlaintextMachineAuth(fetchImpl).status({
			serverOrigin: 'https://api.epicenter.so',
		});

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('CredentialStorageFailed');
	});

	test('bearer and active key reads return Ok(null) after expiry while offline reads return keys', async () => {
		await createPlaintextRepository().save('https://api.epicenter.so', {
			bearerToken: 'bearer-token',
			session: makeSession({ expiresAt: '2025-01-01T00:00:00.000Z' }),
		});
		const machineAuth = createPlaintextMachineAuth(fetch);

		const bearer = await machineAuth.getBearerToken({
			serverOrigin: 'https://api.epicenter.so',
		});
		const active = await machineAuth.getActiveEncryptionKeys({
			serverOrigin: 'https://api.epicenter.so',
		});
		const offline = await machineAuth.getOfflineEncryptionKeys({
			serverOrigin: 'https://api.epicenter.so',
		});

		expect(bearer).toEqual({ data: null, error: null });
		expect(active).toEqual({ data: null, error: null });
		expect(offline).toEqual({ data: encryptionKeys, error: null });
	});

	test('direct readers return Ok(null) for absent credentials', async () => {
		const result = await createPlaintextMachineAuth(fetch).getBearerToken({
			serverOrigin: 'https://api.epicenter.so',
		});

		expect(result).toEqual({ data: null, error: null });
	});

	test('direct readers return Err for invalid credential files', async () => {
		await Bun.write(credentialFilePath, '{not-json');

		const result = await createPlaintextMachineAuth(fetch).getBearerToken({
			serverOrigin: 'https://api.epicenter.so',
		});

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('CredentialStorageFailed');
	});

	test('token getter returns null for absent credentials', async () => {
		const getToken = createMachineTokenGetter({
			serverOrigin: 'https://api.epicenter.so',
			getBearerToken: createPlaintextMachineAuth(fetch).getBearerToken,
		});

		await expect(getToken()).resolves.toBeNull();
	});

	test('token getter throws typed errors for integrity failures', async () => {
		await Bun.write(credentialFilePath, '{not-json');
		const getToken = createMachineTokenGetter({
			serverOrigin: 'https://api.epicenter.so',
			getBearerToken: createPlaintextMachineAuth(fetch).getBearerToken,
		});

		await expect(getToken()).rejects.toMatchObject({
			name: 'CredentialStorageFailed',
		});
	});

	test('token getter requires serverOrigin', () => {
		expect(() =>
			createMachineTokenGetter(
				{} as Parameters<typeof createMachineTokenGetter>[0],
			),
		).toThrow('Expected a server origin');
	});
});
