/**
 * Machine Credential Repository Tests
 *
 * Verifies the Node machine credential repository contract for plaintext test
 * storage and OS keychain backed storage.
 *
 * Key behaviors:
 * - Bearer-equivalent secrets stay out of JSON in keychain mode
 * - Secure storage failures fail closed before writing credentials
 * - Corrupt credential files are rejected rather than replaced
 * - Expired credentials keep offline encryption keys available
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from '../contracts/session.js';
import {
	createMachineCredentialRepository,
	type MachineCredentialRepositoryStoragePolicy,
} from './machine-credential-repository.js';
import type {
	MachineCredentialSecretRef,
	MachineCredentialSecretVault,
} from './machine-credential-secret-vault.js';

const encryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] as const;

function makeSession(
	expiresAt: string,
	{
		userId = 'user-1',
		name = 'User One',
		email = 'user@example.com',
		sessionToken = 'session-token',
	}: {
		userId?: string;
		name?: string;
		email?: string;
		sessionToken?: string;
	} = {},
): Session {
	return {
		user: {
			id: userId,
			name,
			email,
			emailVerified: true,
			image: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		session: {
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
} = {}): MachineCredentialSecretVault & { values: Map<string, string> } {
	const values = new Map<string, string>();
	const key = (ref: MachineCredentialSecretRef) =>
		`${ref.service}:${ref.account}`;
	return {
		kind: 'systemKeychain',
		values,
		async isAvailable() {
			return available;
		},
		async selfTest() {
			if (selfTestFails) throw new Error('keychain locked');
		},
		async save(ref, value) {
			values.set(key(ref), value);
		},
		async load(ref) {
			return values.get(key(ref)) ?? null;
		},
		async delete(ref) {
			values.delete(key(ref));
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
	credentialStorage: MachineCredentialRepositoryStoragePolicy = {
		kind: 'plaintextFile',
	},
) {
	return createMachineCredentialRepository({
		path: storePath('credentials.json'),
		credentialStorage,
		clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
	});
}

describe('createMachineCredentialRepository', () => {
	test('writes and reads the versioned credential file', async () => {
		const repository = createRepository();
		await repository.save('https://api.epicenter.so', {
			bearerToken: 'bearer-token',
			session: makeSession('2026-02-01T00:00:00.000Z'),
		});

		const credential = await repository.get('https://api.epicenter.so');
		expect(credential?.bearerToken).toBe('bearer-token');
		expect(credential?.session.session.token).toBe('session-token');

		const file = await Bun.file(storePath('credentials.json')).json();
		expect(file.version).toBe('epicenter.auth.credentialStore.v1');
		expect(file.currentServerOrigin).toBe('https://api.epicenter.so');
	});

	test('keeps keychain secrets out of the JSON file', async () => {
		const secrets = memorySecretVault();
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			credentialStorage: { kind: 'keychain', secretVault: secrets },
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await repository.save('https://api.epicenter.so', {
			bearerToken: 'bearer-token',
			session: makeSession('2026-02-01T00:00:00.000Z'),
		});

		const text = await Bun.file(storePath('credentials.json')).text();
		expect(text).not.toContain('bearer-token');
		expect(text).not.toContain('session-token');
		expect(text).not.toContain(encryptionKeys[0].userKeyBase64);
		expect(await repository.getBearerToken('https://api.epicenter.so')).toBe(
			'bearer-token',
		);
	});

	test('removes stale keychain secrets when replacing a server credential', async () => {
		const secrets = memorySecretVault();
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			credentialStorage: { kind: 'keychain', secretVault: secrets },
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await repository.save('https://api.epicenter.so', {
			bearerToken: 'old-bearer-token',
			session: makeSession('2026-02-01T00:00:00.000Z', {
				userId: 'old-user',
				sessionToken: 'old-session-token',
			}),
		});
		await repository.save('https://api.epicenter.so', {
			bearerToken: 'new-bearer-token',
			session: makeSession('2026-02-01T00:00:00.000Z', {
				userId: 'new-user',
				sessionToken: 'new-session-token',
			}),
		});

		const keys = [...secrets.values.keys()];
		expect(keys.some((key) => key.includes('old-user'))).toBe(false);
		expect(keys.some((key) => key.includes('new-user'))).toBe(true);
		expect(await repository.getBearerToken('https://api.epicenter.so')).toBe(
			'new-bearer-token',
		);
	});

	test('current credential with missing keychain secrets does not fall back to another server', async () => {
		const secrets = memorySecretVault();
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			credentialStorage: { kind: 'keychain', secretVault: secrets },
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await repository.save('https://first.example.com', {
			bearerToken: 'first-bearer-token',
			session: makeSession('2026-02-01T00:00:00.000Z', {
				userId: 'first-user',
			}),
		});
		await repository.save('https://second.example.com', {
			bearerToken: 'second-bearer-token',
			session: makeSession('2026-02-01T00:00:00.000Z', {
				userId: 'second-user',
			}),
		});
		for (const key of [...secrets.values.keys()]) {
			if (key.includes('second.example.com')) secrets.values.delete(key);
		}

		expect(await repository.getCurrent()).toBeNull();
		expect(await repository.getBearerToken()).toBeNull();
		expect(await repository.getBearerToken('https://first.example.com')).toBe(
			'first-bearer-token',
		);
		expect((await repository.getMetadata())?.serverOrigin).toBe(
			'https://second.example.com',
		);
	});

	test('fails closed when secure storage is unavailable', async () => {
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			credentialStorage: {
				kind: 'keychain',
				secretVault: memorySecretVault({ available: false }),
			},
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await expect(
			repository.save('https://api.epicenter.so', {
				bearerToken: 'bearer-token',
				session: makeSession('2026-02-01T00:00:00.000Z'),
			}),
		).rejects.toThrow('OS keychain storage is unavailable');
		expect(await Bun.file(storePath('credentials.json')).exists()).toBe(false);
	});

	test('fails closed when secure storage self-test fails', async () => {
		const repository = createMachineCredentialRepository({
			path: storePath('credentials.json'),
			credentialStorage: {
				kind: 'keychain',
				secretVault: memorySecretVault({ selfTestFails: true }),
			},
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await expect(
			repository.save('https://api.epicenter.so', {
				bearerToken: 'bearer-token',
				session: makeSession('2026-02-01T00:00:00.000Z'),
			}),
		).rejects.toThrow('keychain locked');
		expect(await Bun.file(storePath('credentials.json')).exists()).toBe(false);
	});

	test('invalid credential files are rejected before save can replace them', async () => {
		const path = storePath('credentials.json');
		await Bun.write(path, '{not-json');
		const repository = createMachineCredentialRepository({
			path,
			credentialStorage: { kind: 'plaintextFile' },
			clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
		});

		await expect(
			repository.save('https://api.epicenter.so', {
				bearerToken: 'bearer-token',
				session: makeSession('2026-02-01T00:00:00.000Z'),
			}),
		).rejects.toThrow('Invalid credential file JSON');
		expect(await Bun.file(path).text()).toBe('{not-json');
	});

	test('splits online and offline key read policies after expiry', async () => {
		const repository = createRepository();
		await repository.save('https://api.epicenter.so', {
			bearerToken: 'bearer-token',
			session: makeSession('2025-01-01T00:00:00.000Z'),
		});

		expect(
			await repository.getBearerToken('https://api.epicenter.so'),
		).toBeNull();
		expect(
			await repository.getActiveEncryptionKeys('https://api.epicenter.so'),
		).toBeNull();
		expect(
			await repository.getOfflineEncryptionKeys('https://api.epicenter.so'),
		).toEqual([...encryptionKeys]);
	});
});
