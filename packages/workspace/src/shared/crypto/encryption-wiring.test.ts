/**
 * Encryption Wiring Factory Tests
 *
 * Verifies that `createEncryptionWiring()` correctly bridges the async HKDF
 * derivation gap between auth sessions and workspace lock/unlock. Tests the
 * four hard parts: async bridging, mode guards, duplicate key dedup, and
 * race protection via generation counter.
 *
 * Key behaviors:
 * - connect() derives workspace key via HKDF then calls unlock()
 * - disconnect() calls lock() or clearLocalData() based on wipe flag
 * - disconnect() is a no-op when mode is not 'unlocked'
 * - Duplicate connect() with same key is a no-op
 * - Race: disconnect() during in-flight derivation cancels stale unlock
 * - Race: rapid connect() calls — only latest key wins
 * - loadCachedKey() reads from keyCache and calls connect()
 */

import { describe, expect, mock, test } from 'bun:test';
import type { EncryptionMode } from '../y-keyvalue/y-keyvalue-lww-encrypted';
import {
	createEncryptionWiring,
	type EncryptionWiringClient,
} from './encryption-wiring';
import { generateEncryptionKey } from './index';
import type { KeyCache } from './key-cache';

// ============================================================================
// Setup
// ============================================================================

function setup(overrides?: { mode?: EncryptionMode }) {
	const mode = overrides?.mode ?? 'plaintext';

	const client: EncryptionWiringClient = {
		id: 'test-workspace',
		get mode() {
			return mode;
		},
		lock: mock(() => {}),
		unlock: mock(() => {}),
		clearLocalData: mock(() => Promise.resolve()),
	};

	const wiring = createEncryptionWiring(client);

	return { client, wiring };
}

function setupWithMutableMode() {
	let mode: EncryptionMode = 'plaintext';

	const client: EncryptionWiringClient = {
		id: 'test-workspace',
		get mode() {
			return mode;
		},
		lock: mock(() => {
			mode = 'locked';
		}),
		unlock: mock(((_key: Uint8Array) => {
			mode = 'unlocked';
		}) as (key: Uint8Array) => void),
		clearLocalData: mock(async () => {
			mode = 'locked';
		}),
	};

	const wiring = createEncryptionWiring(client);

	return { client, wiring, getMode: () => mode };
}

function setupWithKeyCache() {
	const store = new Map<string, Uint8Array>();

	const keyCache: KeyCache = {
		set: mock(async (userId: string, key: Uint8Array) => {
			store.set(userId, key);
		}),
		get: mock(async (userId: string) => store.get(userId)),
		clear: mock(async () => {
			store.clear();
		}),
	};

	let mode: EncryptionMode = 'plaintext';

	const client: EncryptionWiringClient = {
		id: 'test-workspace',
		get mode() {
			return mode;
		},
		lock: mock(() => {
			mode = 'locked';
		}),
		unlock: mock(((_key: Uint8Array) => {
			mode = 'unlocked';
		}) as (key: Uint8Array) => void),
		clearLocalData: mock(async () => {
			mode = 'locked';
		}),
	};

	const wiring = createEncryptionWiring(client, keyCache);

	return { client, wiring, keyCache, store };
}

function makeKey(): Uint8Array {
	return generateEncryptionKey();
}

// ============================================================================
// connect()
// ============================================================================

describe('connect', () => {
	test('calls deriveWorkspaceKey then unlock() with derived key', async () => {
		const { client, wiring } = setup();

		wiring.connect(makeKey());

		// deriveWorkspaceKey is async — wait for microtask queue to flush
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
		const unlockArg = (client.unlock as ReturnType<typeof mock>).mock
			.calls[0]![0] as Uint8Array;
		expect(unlockArg).toBeInstanceOf(Uint8Array);
		expect(unlockArg.length).toBe(32);
	});

	test('duplicate key skip — same connect() twice calls unlock() once', async () => {
		const { client, wiring } = setup();
		const key = makeKey();

		wiring.connect(key);
		wiring.connect(key);

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
	});

	test('different keys each trigger unlock()', async () => {
		const { client, wiring } = setup();

		wiring.connect(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		wiring.connect(makeKey());
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// disconnect()
// ============================================================================

describe('disconnect', () => {
	test('calls lock() when mode is unlocked', () => {
		const { client, wiring } = setup({ mode: 'unlocked' });

		wiring.disconnect();

		expect(client.lock).toHaveBeenCalledTimes(1);
		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('calls clearLocalData() when wipe is true and mode is unlocked', () => {
		const { client, wiring } = setup({ mode: 'unlocked' });

		wiring.disconnect({ wipe: true });

		expect(client.clearLocalData).toHaveBeenCalledTimes(1);
		expect(client.lock).toHaveBeenCalledTimes(0);
	});

	test('no-op when mode is plaintext', () => {
		const { client, wiring } = setup({ mode: 'plaintext' });

		wiring.disconnect();

		expect(client.lock).toHaveBeenCalledTimes(0);
		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('no-op when mode is locked', () => {
		const { client, wiring } = setup({ mode: 'locked' });

		wiring.disconnect();

		expect(client.lock).toHaveBeenCalledTimes(0);
		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('clears fingerprint so next connect() with same key is not skipped', async () => {
		const { client, wiring } = setupWithMutableMode();
		const key = makeKey();

		wiring.connect(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(1);

		wiring.disconnect();

		wiring.connect(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// Race protection
// ============================================================================

describe('race protection', () => {
	test('disconnect() during in-flight derivation cancels stale unlock()', async () => {
		const { client, wiring } = setup({ mode: 'unlocked' });

		wiring.connect(makeKey());
		// disconnect immediately — before HKDF resolves
		wiring.disconnect();

		await new Promise((resolve) => setTimeout(resolve, 50));

		// unlock() should NOT have been called — the generation check prevents it
		expect(client.unlock).toHaveBeenCalledTimes(0);
		// lock() should have been called from disconnect()
		expect(client.lock).toHaveBeenCalledTimes(1);
	});

	test('rapid connect() calls — only latest key wins', async () => {
		const { client, wiring } = setup();

		// Fire three rapid connect() calls
		wiring.connect(makeKey());
		wiring.connect(makeKey());
		wiring.connect(makeKey());

		await new Promise((resolve) => setTimeout(resolve, 100));

		// Only the last connect() should result in unlock()
		// (first two are superseded by generation counter)
		expect(client.unlock).toHaveBeenCalledTimes(1);
	});
});

// ============================================================================
// loadCachedKey()
// ============================================================================

describe('loadCachedKey', () => {
	test('returns false when no keyCache configured', async () => {
		const { wiring } = setup();

		const result = await wiring.loadCachedKey('user-1');

		expect(result).toBe(false);
	});

	test('returns false when keyCache has no entry for userId', async () => {
		const { wiring } = setupWithKeyCache();

		const result = await wiring.loadCachedKey('nonexistent-user');

		expect(result).toBe(false);
	});

	test('returns true and calls connect() when cached key exists', async () => {
		const { client, wiring, store } = setupWithKeyCache();

		// Pre-seed the cache
		const userKey = generateEncryptionKey();
		store.set('user-1', userKey);

		const result = await wiring.loadCachedKey('user-1');

		expect(result).toBe(true);

		// Wait for HKDF derivation
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(client.unlock).toHaveBeenCalledTimes(1);
	});

	test('connect() caches key when userId and keyCache provided', async () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.connect(makeKey(), 'user-1');

		expect(keyCache.set).toHaveBeenCalledTimes(1);
	});

	test('disconnect({ wipe: true }) clears keyCache', () => {
		const { wiring, keyCache } = setupWithKeyCache();

		// Need to connect first so mode becomes unlocked
		wiring.connect(makeKey(), 'user-1');

		wiring.disconnect({ wipe: true });

		expect(keyCache.clear).toHaveBeenCalledTimes(1);
	});

	test('disconnect({ wipe: false }) does not clear keyCache', () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.disconnect();

		expect(keyCache.clear).toHaveBeenCalledTimes(0);
	});
});
