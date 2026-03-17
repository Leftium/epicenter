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
 * - setKey() derives workspace key via HKDF then calls unlock()
 * - lock() always calls client.lock() (client handles mode guards)
 * - wipe() always calls clearLocalData() + keyCache.clear()
 * - Duplicate setKey() with same key is a no-op
 * - Race: lock() during in-flight derivation cancels stale unlock
 * - Race: rapid setKey() calls — only latest key wins
 * - restoreKeyFromCache() reads from keyCache and calls setKey()
 */

import { describe, expect, mock, test } from 'bun:test';
import type { EncryptionMode } from '../y-keyvalue/y-keyvalue-lww-encrypted';
import {
	createKeyManager,
	type KeyManagerTarget,
} from './key-manager';
import { bytesToBase64, generateEncryptionKey } from './index';
import type { KeyCache } from './key-cache';

// ============================================================================
// Setup
// ============================================================================

function setup() {
	const client: KeyManagerTarget = {
		id: 'test-workspace',
		lock: mock(() => {}),
		unlock: mock(() => {}),
		clearLocalData: mock(() => Promise.resolve()),
	};

	const wiring = createKeyManager(client);

	return { client, wiring };
}

function setupWithMutableMode() {
	let mode: EncryptionMode = 'none';

	const client: KeyManagerTarget = {
		id: 'test-workspace',
		lock: mock(() => {
			mode = 'locked';
		}),
		unlock: mock(((_key: Uint8Array) => {
			mode = 'active';
		}) as (key: Uint8Array) => void),
		clearLocalData: mock(async () => {
			mode = 'locked';
		}),
	};

	const wiring = createKeyManager(client);

	return { client, wiring, getMode: () => mode };
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
		lock: mock(() => {}),
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
// setKey()
// ============================================================================

describe('setKey', () => {
	test('calls deriveWorkspaceKey then unlock() with derived key', async () => {
		const { client, wiring } = setup();

		wiring.setKey(makeKey());

		// deriveWorkspaceKey is async — wait for microtask queue to flush
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
		const unlockArg = (client.unlock as ReturnType<typeof mock>).mock
			.calls[0]![0] as Uint8Array;
		expect(unlockArg).toBeInstanceOf(Uint8Array);
		expect(unlockArg.length).toBe(32);
	});

	test('duplicate key skip — same setKey() twice calls unlock() once', async () => {
		const { client, wiring } = setup();
		const key = makeKey();

		wiring.setKey(key);
		wiring.setKey(key);

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
	});

	test('different keys each trigger unlock()', async () => {
		const { client, wiring } = setup();

		wiring.setKey(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		wiring.setKey(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// lock()
// ============================================================================

describe('lock', () => {
	test('always calls client.lock()', () => {
		const { client, wiring } = setup();

		wiring.lock();

		expect(client.lock).toHaveBeenCalledTimes(1);
		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('clears fingerprint so next setKey() with same key is not skipped', async () => {
		const { client, wiring } = setupWithMutableMode();
		const key = makeKey();

		wiring.setKey(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(1);

		wiring.lock();

		wiring.setKey(key);
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

	test('clears fingerprint so next setKey() with same key is not skipped', async () => {
		const { client, wiring } = setupWithMutableMode();
		const key = makeKey();

		wiring.setKey(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(1);

		wiring.wipe();

		wiring.setKey(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// Race protection
// ============================================================================

describe('race protection', () => {
	test('lock() during in-flight derivation cancels stale unlock()', async () => {
		const { client, wiring } = setup();

		wiring.setKey(makeKey());
		// lock immediately — before HKDF resolves
		wiring.lock();

		await new Promise((resolve) => setTimeout(resolve, 50));

		// unlock() should NOT have been called — the generation check prevents it
		expect(client.unlock).toHaveBeenCalledTimes(0);
		// lock() should have been called
		expect(client.lock).toHaveBeenCalledTimes(1);
	});

	test('rapid setKey() calls — only latest key wins', async () => {
		const { client, wiring } = setup();

		// Fire three rapid setKey() calls
		wiring.setKey(makeKey());
		wiring.setKey(makeKey());
		wiring.setKey(makeKey());

		await new Promise((resolve) => setTimeout(resolve, 100));

		// Only the last setKey() should result in unlock()
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

	test('returns true and calls setKey() when cached key exists', async () => {
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

	test('setKey() caches key when userId and keyCache provided', async () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.setKey(makeKey(), 'user-1');

		expect(keyCache.set).toHaveBeenCalledTimes(1);
	});

	test('wipe() clears keyCache', async () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.setKey(makeKey(), 'user-1');

		await wiring.wipe();

		expect(keyCache.clear).toHaveBeenCalledTimes(1);
	});

	test('lock() does not clear keyCache', () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.lock();

		expect(keyCache.clear).toHaveBeenCalledTimes(0);
	});
});
