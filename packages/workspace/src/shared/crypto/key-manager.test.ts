/**
 * Key Manager Factory Tests
 *
 * Verifies that `createKeyManager()` correctly bridges the async HKDF
 * derivation gap between auth sessions and workspace lock/unlock. Tests the
 * three hard parts: async bridging, duplicate key dedup, and race protection
 * via generation counter.
 *
 * The key manager always calls through to the client — mode guarding is the
 * client's responsibility, not the key manager's.
 *
 * Key behaviors:
 * - unlock() derives workspace key via HKDF then calls unlock()
 * - wipe() always calls clearLocalData() + keyCache.clear()
 * - Duplicate unlock() with same key is a no-op
 * - Race: rapid unlock() calls — only latest key wins
 * - restoreKeyFromCache() reads from keyCache and calls unlock()
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
		unlock: mock(() => {}),
		clearLocalData: mock(() => Promise.resolve()),
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
		unlock: mock(() => {}),
		clearLocalData: mock(() => Promise.resolve()),
	};

	const wiring = createKeyManager(client, { keyCache });

	return { client, wiring, keyCache, store };
}

/** Generate a random base64-encoded encryption key. */
function makeKey(): string {
	return bytesToBase64(generateEncryptionKey());
}

// ============================================================================
// unlock()
// ============================================================================

describe('unlock', () => {
	test('calls deriveWorkspaceKey then unlock() with derived key', async () => {
		const { client, wiring } = setup();

		wiring.unlock(makeKey());

		// deriveWorkspaceKey is async — wait for microtask queue to flush
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
		const unlockArg = (client.unlock as ReturnType<typeof mock>).mock
			.calls[0]![0] as Uint8Array;
		expect(unlockArg).toBeInstanceOf(Uint8Array);
		expect(unlockArg.length).toBe(32);
	});

	test('duplicate key skip — same unlock() twice calls unlock() once', async () => {
		const { client, wiring } = setup();
		const key = makeKey();

		wiring.unlock(key);
		wiring.unlock(key);

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
	});

	test('different keys each trigger unlock()', async () => {
		const { client, wiring } = setup();

		wiring.unlock(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		wiring.unlock(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// wipe()
// ============================================================================

describe('wipe', () => {
	test('always calls clearLocalData()', () => {
		const { client, wiring } = setup();

		wiring.wipe();

		expect(client.clearLocalData).toHaveBeenCalledTimes(1);
	});

	test('clears fingerprint so next unlock() with same key is not skipped', async () => {
		const { client, wiring } = setup();
		const key = makeKey();

		wiring.unlock(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(1);

		wiring.wipe();

		wiring.unlock(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// Race protection
// ============================================================================

describe('race protection', () => {
	test('rapid unlock() calls — only latest key wins', async () => {
		const { client, wiring } = setup();

		// Fire three rapid unlock() calls
		wiring.unlock(makeKey());
		wiring.unlock(makeKey());
		wiring.unlock(makeKey());

		await new Promise((resolve) => setTimeout(resolve, 100));

		// Only the last unlock() should result in unlock()
		// (first two are superseded by generation counter)
		expect(client.unlock).toHaveBeenCalledTimes(1);
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

	test('returns true and calls unlock() when cached key exists', async () => {
		const { client, wiring, store } = setupWithKeyCache();

		// Pre-seed the cache with a base64 key
		const keyBase64 = makeKey();
		store.set('user-1', keyBase64);

		const result = await wiring.restoreKeyFromCache('user-1');

		expect(result).toBe(true);

		// Wait for HKDF derivation
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
	});

	test('unlock() caches key when userId and keyCache provided', async () => {
		const { wiring, keyCache } = setupWithKeyCache();

		await wiring.unlock(makeKey(), 'user-1');

		expect(keyCache.set).toHaveBeenCalledTimes(1);
	});

	test('wipe() clears keyCache', async () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.unlock(makeKey(), 'user-1');

		await wiring.wipe();

		expect(keyCache.clear).toHaveBeenCalledTimes(1);
	});
});
