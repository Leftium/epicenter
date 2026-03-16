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
 * - lock() calls client.lock() when mode is unlocked
 * - wipeLocalData() calls clearLocalData() + keyCache.clear()
 * - lock()/wipeLocalData() are no-ops when mode is not 'unlocked'
 * - Duplicate connect() with same key is a no-op
 * - Race: lock() during in-flight derivation cancels stale unlock
 * - Race: rapid connect() calls — only latest key wins
 * - loadCachedKey() reads from keyCache and calls connect()
 */

import { describe, expect, mock, test } from 'bun:test';
import type { EncryptionMode } from '../y-keyvalue/y-keyvalue-lww-encrypted';
import {
	createEncryptionWiring,
	type EncryptionWiringClient,
} from './encryption-wiring';
import { bytesToBase64, generateEncryptionKey } from './index';
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

	const wiring = createEncryptionWiring(client, { keyCache });

	return { client, wiring, keyCache, store };
}

/** Generate a random base64-encoded encryption key. */
function makeKey(): string {
	return bytesToBase64(generateEncryptionKey());
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
// lock()
// ============================================================================

describe('lock', () => {
	test('calls client.lock() when mode is unlocked', () => {
		const { client, wiring } = setup({ mode: 'unlocked' });

		wiring.lock();

		expect(client.lock).toHaveBeenCalledTimes(1);
		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('no-op when mode is plaintext', () => {
		const { client, wiring } = setup({ mode: 'plaintext' });

		wiring.lock();

		expect(client.lock).toHaveBeenCalledTimes(0);
		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('no-op when mode is locked', () => {
		const { client, wiring } = setup({ mode: 'locked' });

		wiring.lock();

		expect(client.lock).toHaveBeenCalledTimes(0);
		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('clears fingerprint so next connect() with same key is not skipped', async () => {
		const { client, wiring } = setupWithMutableMode();
		const key = makeKey();

		wiring.connect(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(1);

		wiring.lock();

		wiring.connect(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// wipeLocalData()
// ============================================================================

describe('wipeLocalData', () => {
	test('calls clearLocalData() when mode is unlocked', () => {
		const { client, wiring } = setup({ mode: 'unlocked' });

		wiring.wipeLocalData();

		expect(client.clearLocalData).toHaveBeenCalledTimes(1);
		expect(client.lock).toHaveBeenCalledTimes(0);
	});

	test('no-op for clearLocalData when mode is plaintext', () => {
		const { client, wiring } = setup({ mode: 'plaintext' });

		wiring.wipeLocalData();

		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('no-op for clearLocalData when mode is locked', () => {
		const { client, wiring } = setup({ mode: 'locked' });

		wiring.wipeLocalData();

		expect(client.clearLocalData).toHaveBeenCalledTimes(0);
	});

	test('clears fingerprint so next connect() with same key is not skipped', async () => {
		const { client, wiring } = setupWithMutableMode();
		const key = makeKey();

		wiring.connect(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(1);

		wiring.wipeLocalData();

		wiring.connect(key);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.unlock).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// Race protection
// ============================================================================

describe('race protection', () => {
	test('lock() during in-flight derivation cancels stale unlock()', async () => {
		const { client, wiring } = setup({ mode: 'unlocked' });

		wiring.connect(makeKey());
		// lock immediately — before HKDF resolves
		wiring.lock();

		await new Promise((resolve) => setTimeout(resolve, 50));

		// unlock() should NOT have been called — the generation check prevents it
		expect(client.unlock).toHaveBeenCalledTimes(0);
		// lock() should have been called
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

		// Pre-seed the cache with a base64 key
		const keyBase64 = makeKey();
		store.set('user-1', keyBase64);

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

	test('wipeLocalData() clears keyCache', () => {
		const { wiring, keyCache } = setupWithKeyCache();

		// Need to connect first so mode becomes unlocked
		wiring.connect(makeKey(), 'user-1');

		wiring.wipeLocalData();

		expect(keyCache.clear).toHaveBeenCalledTimes(1);
	});

	test('lock() does not clear keyCache', () => {
		const { wiring, keyCache } = setupWithKeyCache();

		wiring.lock();

		expect(keyCache.clear).toHaveBeenCalledTimes(0);
	});
});
