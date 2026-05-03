/**
 * Machine Credential Repository Tests
 *
 * Verifies the Node machine credential repository contract for plaintext test
 * storage and OS keychain backed storage.
 *
 * Key behaviors:
 * - Authorization secrets stay out of JSON in keychain mode
 * - Secure storage failures fail closed before writing credentials
 * - Corrupt credential files are rejected rather than replaced
 * - Expired credentials remain readable as persisted records
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthCredential } from '../contracts/auth-credential.js';
import { createMachineCredentialRepository } from './machine-credential-repository.js';
import {
	createKeychainMachineCredentialSecretStorage,
	createPlaintextMachineCredentialSecretStorage,
	type MachineCredentialSecretBackend,
	type MachineCredentialSecretStorage,
} from './machine-credential-secret-storage.js';

const encryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] as const;

function makeCredential(
	expiresAt: string,
	{
		serverOrigin = 'https://api.epicenter.so',
		authorizationToken = 'authorization-token',
		userId = 'user-1',
		name = 'User One',
		email = 'user@example.com',
		sessionToken = 'session-token',
	}: {
		serverOrigin?: string;
		authorizationToken?: string;
		userId?: string;
		name?: string;
		email?: string;
		sessionToken?: string;
	} = {},
): AuthCredential {
	return {
		serverOrigin,
		authorizationToken,
		user: {
			id: userId,
			name,
			email,
			emailVerified: true,
			image: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		serverSession: {
			id: `${userId}-session`,
			token: sessionToken,
			userId,
			expiresAt,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			ipAddress: null,
			userAgent: null,
		},
		encryptionKeys: [...encryptionKeys],
	};
}

function memorySecretVault({
	available = true,
	selfTestFails = false,
}: {
	available?: boolean;
	selfTestFails?: boolean;
} = {}): MachineCredentialSecretBackend & { values: Map<string, string> } {
	const values = new Map<string, string>();
	const key = (options: { service: string; name: string }) =>
		`${options.service}:${options.name}`;
	return {
		values,
		async get(options) {
			return values.get(key(options)) ?? null;
		},
		async set(options, value) {
			if (!available) {
				throw new Error(
					'OS keychain storage is unavailable. Rerun with --insecure-storage to use plaintext file storage.',
				);
			}
			if (selfTestFails && options.service === 'epicenter.auth.selfTest') {
				throw new Error('keychain locked');
			}
			values.set(key(options), value);
		},
		async delete(options) {
			values.delete(key(options));
		},
	};
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp('/tmp/epicenter-auth-test-');
});

function storePath(name: string) {
	return join(dir, name);
}

function createRepository(
	secretStorage: MachineCredentialSecretStorage = createPlaintextMachineCredentialSecretStorage(),
) {
	return createMachineCredentialRepository({
		path: storePath('credentials.json'),
		secretStorage,
		clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
	});
}

describe('createMachineCredentialRepository', () => {
	test('writes and reads the versioned credential file', async () => {
		const repository = createRepository();
		await repository.save('https://api.epicenter.so', {
			authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
				authorizationToken: 'authorization-token',
			}),
		});

		const credential = await repository.get('https://api.epicenter.so');
		expect(credential?.authCredential.authorizationToken).toBe(
			'authorization-token',
		);
		expect(credential?.authCredential.serverSession.token).toBe(
			'session-token',
		);

		const file = await Bun.file(storePath('credentials.json')).json();
		expect(file.version).toBe('epicenter.auth.credentialStore.v2');
		expect(file.currentServerOrigin).toBe('https://api.epicenter.so');
	});

	test('keeps keychain secrets out of the JSON file', async () => {
		const secrets = memorySecretVault();
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			secretStorage: createKeychainMachineCredentialSecretStorage({
				backend: secrets,
			}),
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await repository.save('https://api.epicenter.so', {
			authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
				authorizationToken: 'authorization-token',
			}),
		});

		const text = await Bun.file(storePath('credentials.json')).text();
		expect(text).not.toContain('authorization-token');
		expect(text).not.toContain('session-token');
		expect(text).not.toContain(encryptionKeys[0].userKeyBase64);
		const credential = await repository.get('https://api.epicenter.so');
		expect(credential?.authCredential.authorizationToken).toBe(
			'authorization-token',
		);
	});

	test('removes stale keychain secrets when replacing a server credential', async () => {
		const secrets = memorySecretVault();
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			secretStorage: createKeychainMachineCredentialSecretStorage({
				backend: secrets,
			}),
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await repository.save('https://api.epicenter.so', {
			authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
				authorizationToken: 'old-authorization-token',
				userId: 'old-user',
				sessionToken: 'old-session-token',
			}),
		});
		await repository.save('https://api.epicenter.so', {
			authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
				authorizationToken: 'new-authorization-token',
				userId: 'new-user',
				sessionToken: 'new-session-token',
			}),
		});

		const keys = [...secrets.values.keys()];
		expect(keys.some((key) => key.includes('old-user'))).toBe(false);
		expect(keys.some((key) => key.includes('new-user'))).toBe(true);
		const credential = await repository.get('https://api.epicenter.so');
		expect(credential?.authCredential.authorizationToken).toBe(
			'new-authorization-token',
		);
	});

	test('current credential with missing keychain secrets does not fall back to another server', async () => {
		const secrets = memorySecretVault();
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			secretStorage: createKeychainMachineCredentialSecretStorage({
				backend: secrets,
			}),
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await repository.save('https://first.example.com', {
			authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
				serverOrigin: 'https://first.example.com',
				authorizationToken: 'first-authorization-token',
				userId: 'first-user',
			}),
		});
		await repository.save('https://second.example.com', {
			authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
				serverOrigin: 'https://second.example.com',
				authorizationToken: 'second-authorization-token',
				userId: 'second-user',
			}),
		});
		for (const key of [...secrets.values.keys()]) {
			if (key.includes('second.example.com')) secrets.values.delete(key);
		}

		expect(await repository.getCurrent()).toBeNull();
		expect(
			(await repository.get('https://first.example.com'))?.authCredential
				.authorizationToken,
		).toBe('first-authorization-token');
		expect((await repository.getMetadata())?.authCredential.serverOrigin).toBe(
			'https://second.example.com',
		);
	});

	test('fails closed when secure storage is unavailable', async () => {
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			secretStorage: createKeychainMachineCredentialSecretStorage({
				backend: memorySecretVault({ available: false }),
			}),
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await expect(
			repository.save('https://api.epicenter.so', {
				authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
					authorizationToken: 'authorization-token',
				}),
			}),
		).rejects.toThrow('OS keychain storage is unavailable');
		expect(await Bun.file(storePath('credentials.json')).exists()).toBe(false);
	});

	test('fails closed when secure storage self-test fails', async () => {
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			secretStorage: createKeychainMachineCredentialSecretStorage({
				backend: memorySecretVault({ selfTestFails: true }),
			}),
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await expect(
			repository.save('https://api.epicenter.so', {
				authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
					authorizationToken: 'authorization-token',
				}),
			}),
		).rejects.toThrow('keychain locked');
		expect(await Bun.file(storePath('credentials.json')).exists()).toBe(false);
	});

	test('invalid credential files are rejected before save can replace them', async () => {
		const path = storePath('credentials.json');
		await Bun.write(path, '{not-json');
		const repository = createMachineCredentialRepository({
			path,
			secretStorage: createPlaintextMachineCredentialSecretStorage(),
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await expect(
			repository.save('https://api.epicenter.so', {
				authCredential: makeCredential('2026-02-01T00:00:00.000Z', {
					authorizationToken: 'authorization-token',
				}),
			}),
		).rejects.toThrow('Invalid credential file JSON');
		expect(await Bun.file(path).text()).toBe('{not-json');
	});

	test('reads expired credentials without applying auth policy', async () => {
		const repository = createRepository();
		await repository.save('https://api.epicenter.so', {
			authCredential: makeCredential('2025-01-01T00:00:00.000Z', {
				authorizationToken: 'authorization-token',
			}),
		});

		const credential = await repository.get('https://api.epicenter.so');

		expect(credential?.authCredential.authorizationToken).toBe(
			'authorization-token',
		);
		expect(credential?.authCredential.serverSession.expiresAt).toBe(
			'2025-01-01T00:00:00.000Z',
		);
		expect(credential?.authCredential.encryptionKeys).toEqual([
			...encryptionKeys,
		]);
	});
});
