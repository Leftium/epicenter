/**
 * Key Manager Factory Tests
 *
 * Verifies that `createKeyManager()` correctly bridges the async HKDF
 * derivation gap between auth sessions and workspace encryption activation. Tests the
 * three hard parts: async bridging, duplicate key dedup, and race protection
 * via generation counter.
 *
 * The key manager always calls through to the client — mode guarding is the
 * client's responsibility, not the key manager's.
 *
 * Key behaviors:
 * - activateEncryption() derives workspace key via HKDF then calls activateEncryption()
 * - clearKeys() clears keyCache and activateEncryption dedup fingerprint
 * - Duplicate activateEncryption() with same key is a no-op
 * - Race: rapid activateEncryption() calls — only latest key wins
 * - restoreKeyFromCache() reads from keyCache and calls activateEncryption()
 */

import { describe, expect, mock, test } from 'bun:test';
import { bytesToBase64, generateEncryptionKey } from './index';
import type { KeyCache } from './key-cache';
import { createKeyManager, type KeyManagerTarget } from './key-manager';

// ============================================================================
// Setup
// ============================================================================

function setup() {
	const client: KeyManagerTarget = {
		id: 'test-workspace',
		activateEncryption: mock(() => {}),
	};

	const wiring = createKeyManager(client);

	return { client, wiring };
}

function setupWithKeyCache() {
	const store = new Map<string, string>();

	const keyCache: KeyCache = {
		set: mock(async (userId: string, keyBase64: string) => {
			store.set(userId, keyBase64);
		}),
		get: mock(async (userId: string) => store.get(userId)),
		clear: mock(async () => {
			store.clear();
		}),
	};
	const client: KeyManagerTarget = {
		id: 'test-workspace',
		activateEncryption: mock(() => {}),
	};

	const wiring = createKeyManager(client, { keyCache });

	return { client, wiring, keyCache, store };
}

/** Generate a random base64-encoded encryption key. */
function makeKey(): string {
	return bytesToBase64(generateEncryptionKey());
}

// ============================================================================
// activateEncryption()
// ============================================================================

describe('activateEncryption', () => {
	test('calls deriveWorkspaceKey then activateEncryption() with derived key', async () => {
		const { client, wiring } = setup();

		wiring.activateEncryption(makeKey());

		// deriveWorkspaceKey is async — wait for microtask queue to flush
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.activateEncryption).toHaveBeenCalledTimes(1);
		const unlockArg = (client.activateEncryption as ReturnType<typeof mock>).mock
			.calls[0]![0] as Uint8Array;
		expect(unlockArg).toBeInstanceOf(Uint8Array);
		expect(unlockArg.length).toBe(32);
	});

	test('duplicate key skip — same activateEncryption() twice calls activateEncryption() once', async () => {
		const { client, wiring } = setup();
		const key = makeKey();

		wiring.activateEncryption(key);
		wiring.activateEncryption(key);

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.activateEncryption).toHaveBeenCalledTimes(1);
	});

	test('different keys each trigger activateEncryption()', async () => {
		const { client, wiring } = setup();

		wiring.activateEncryption(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		wiring.activateEncryption(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.activateEncryption).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// clearKeys()
// ============================================================================

describe('clearKeys', () => {
	test('clears fingerprint so next activateEncryption() with same key is not skipped', async () => {
		const { client, wiring } = setup();
		const key = makeKey();

		wiring.activateEncryption(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.activateEncryption).toHaveBeenCalledTimes(1);

		wiring.clearKeys();

		wiring.activateEncryption(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.activateEncryption).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// Race protection
// ============================================================================

describe('race protection', () => {
	test('rapid activateEncryption() calls — only latest key wins', async () => {
		const { client, wiring } = setup();

		// Fire three rapid activateEncryption() calls
		wiring.activateEncryption(makeKey());
		wiring.activateEncryption(makeKey());
		wiring.activateEncryption(makeKey());

		await new Promise((resolve) => setTimeout(resolve, 100));

		// Only the last activateEncryption() should result in activateEncryption()
		// (first two are superseded by generation counter)
		expect(client.activateEncryption).toHaveBeenCalledTimes(1);
	});
});

// ============================================================================
// restoreKeyFromCache()
// ============================================================================

describe('restoreKeyFromCache', () => {
	test('returns false when no keyCache configured', async () => {
		const { wiring } = setup();

		const result = await wiring.restoreKeyFromCache('user-1');

		expect(result).toBe(false);
	});

	test('returns false when keyCache has no entry for userId', async () => {
		const { wiring } = setupWithKeyCache();

		const result = await wiring.restoreKeyFromCache('nonexistent-user');

		expect(result).toBe(false);
	});

	test('returns true and calls activateEncryption() when cached key exists', async () => {
		const { client, wiring, store } = setupWithKeyCache();

		// Pre-seed the cache with a base64 key
		const keyBase64 = makeKey();
		store.set('user-1', keyBase64);

		const result = await wiring.restoreKeyFromCache('user-1');

		expect(result).toBe(true);

		// Wait for HKDF derivation
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.activateEncryption).toHaveBeenCalledTimes(1);
	});

	test('activateEncryption() caches key when userId and keyCache provided', async () => {
		const { wiring, keyCache } = setupWithKeyCache();

		await wiring.activateEncryption(makeKey(), 'user-1');

		expect(keyCache.set).toHaveBeenCalledTimes(1);
	});

	test('clearKeys() clears keyCache', async () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.activateEncryption(makeKey(), 'user-1');

		await wiring.clearKeys();

		expect(keyCache.clear).toHaveBeenCalledTimes(1);
	});
});
