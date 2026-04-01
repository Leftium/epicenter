/**
 * # Encrypted KV-LWW — Composition Wrapper
 *
 * Transparent encryption layer over `YKeyValueLww`. All CRDT logic (timestamps,
 * conflict resolution, pending/map architecture) stays in `YKeyValueLww`; this
 * module transforms values at the boundary and manages encryption state.
 *
 * ## Why Composition Over Fork
 *
 * Yjs `ContentAny` stores entry objects by **reference**. `YKeyValueLww` relies
 * on `indexOf()` (strict `===`) to find entries in the Y.Array during conflict
 * resolution. A fork that decrypts into new objects breaks `indexOf`—the map
 * entries are no longer the same JS objects as the yarray entries.
 *
 * See `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`.
 *
 * ## Data Flow
 *
 * ```
 * set('tab-1', { url: '...' })
 *   ├── JSON.stringify → encryptValue → Uint8Array [fmt‖keyVer‖nonce‖ct‖tag]
 *   └── inner.set('tab-1', encryptedBlob)              ← CRDT source of truth
 *         │                                                (inner handles pending)
 *         ▼  inner.observe fires
 *   ├── inner.map has encrypted entry
 *   ├── maybeDecrypt → plaintext (or skip on failure)
 *   ├── wrapper.map.set('tab-1', plaintext entry)       ← cachedEntries() exposes this
 *   └── change event forwarded with decrypted values
 *
 * get('tab-1')
 *   ├── wrapper.map cache hit? → return plaintext        ← fast path (post-observer)
 *   └── inner.get() → decrypt on the fly                ← transaction gap fallback
 * ```
 *
 * ## Encryption Lifecycle
 *
 * Encryption is governed by key presence (`currentKey`). There is no separate
 * state variable—encryption state is derived internally from `currentKey !== undefined`.
 *
 * ```
 *   Key provided (activateEncryption)
 *   ┌──────────────────┐       ┌──────────────────┐
 *   │  key: present       │◄── activateEncryption(newKey)
 *   │  rw plaintext      │       │  rw encrypted      │
 *   └──────────────────┘       └──────────────────┘
 * ```
 *
 * - **No key**: Reads and writes pass through unencrypted.
 * - **Key present**: `set()` encrypts, observer decrypts.
 *
 * ## Key Management
 *
 * The encryption key is managed through `activateEncryption(key)`. The optional `key`
 * in options seeds the initial key at construction time. After creation,
 * all key transitions go through `activateEncryption()`.
 *
 * ## Pending State
 *
 * The wrapper does NOT maintain its own pending/pendingDeletes maps. The inner
 * `YKeyValueLww` handles all pending logic. During the transaction gap (after
 * `set()` but before the observer fires), `get()` falls back to `inner.get()`
 * and decrypts on the fly. XChaCha20-Poly1305 decrypt of a small JSON blob is microseconds—
 * caching this in a separate pending map is unnecessary indirection.
 *
 * ## Error Containment
 *
 * The observer wraps `maybeDecrypt` with `trySync`. A failed decrypt skips
 * the entry and logs a warning instead of throwing. This prevents one bad blob
 * from crashing all observation. `failedDecryptCount` exposes the number of
 * entries that failed to decrypt. Entries are retried on `activateEncryption()`.
 *
 * ## Related Modules
 *
 * - {@link ../crypto/index.ts} — Encryption primitives (encryptValue, decryptValue, isEncryptedBlob)
 * - {@link ../crypto/key-store.ts} — Platform-agnostic key store (survives page refresh)
 * - {@link ./y-keyvalue-lww.ts} — Inner CRDT that handles conflict resolution (unaware of encryption)
 *
 * @module
 */
import { Ok, trySync } from 'wellcrafted/result';
import type * as Y from 'yjs';
import {
	decryptValue,
	type EncryptedBlob,
	encryptValue,
	isEncryptedBlob,
} from '../crypto';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwChangeHandler,
	type YKeyValueLwwEntry,
} from './y-keyvalue-lww';

const textEncoder = new TextEncoder();

/**
 * Sentinel used for synthetic change events emitted by activateEncryption/
 * deactivateEncryption. These events have no real Y.Transaction because
 * encryption state transitions are not Yjs operations. Handlers can check
 * `(transaction as any).__synthetic` to distinguish from real CRDT events.
 */
const SYNTHETIC_TRANSACTION = Object.freeze({
	__synthetic: true as const,
}) as unknown as Y.Transaction;

/**
 * Options for `createEncryptedYkvLww`.
 *
 * `key` seeds the initial encryption key. If provided, all writes are encrypted
 * immediately. If omitted, the store starts unencrypted. After creation, all key
 * transitions go through `activateEncryption()`.
 */
type EncryptedKvLwwOptions = {
	key?: Uint8Array;
};

/**
 * Return type of `createEncryptedYkvLww`. Same API surface as `YKeyValueLww<T>`
 * plus encryption-specific members (`failedDecryptCount`, `activateEncryption`).
 * All values exposed through this type are **plaintext**—encryption is fully
 * transparent to consumers.
 */
export type YKeyValueLwwEncrypted<T> = {
	set(key: string, val: T): void;
	get(key: string): T | undefined;
	has(key: string): boolean;
	delete(key: string): void;
	entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]>;
	observe(handler: YKeyValueLwwChangeHandler<T>): void;
	unobserve(handler: YKeyValueLwwChangeHandler<T>): void;

	/**
	 * Unlock the workspace with an encryption key. Rebuilds the decrypted map
	 * from `inner.map`, transitions to encrypted state, and fires synthetic
	 * change events for any values that changed.
	 *
	 * @param key - A 32-byte encryption key (required)
	 */
	activateEncryption(key: Uint8Array): void;

	/**
	 * Deactivate encryption. Clears the key and the decrypted cache.
	 * After this call, new writes are plaintext and encrypted entries
	 * are no longer readable until `activateEncryption()` is called again.
	 */
	deactivateEncryption(): void;
	/**
	 * Number of entries that failed to decrypt. Computed as
	 * `inner.map.size - map.size`. Entries are retried on `activateEncryption()`.
	 */
	readonly failedDecryptCount: number;

	/**
	 * Iterate decrypted cache entries. Returns an iterator over `[key, entry]`
	 * pairs from the internal plaintext map. Prevents external mutation
	 * of the internal cache.
	 */
	cachedEntries(): IterableIterator<[string, YKeyValueLwwEntry<T>]>;

	/** Number of successfully decrypted entries in the cache. */
	readonly cachedSize: number;

	/** The underlying Y.Array. Contains **ciphertext** when a key is active. */
	readonly yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>;

	/** The Y.Doc that owns the array. */
	readonly doc: Y.Doc;
};

/**
 * Compose transparent encryption onto `YKeyValueLww` without forking CRDT logic.
 *
 * `YKeyValueLww` remains the single source for conflict resolution; this wrapper
 * only transforms values at the boundary (`set` encrypts, observer/get decrypts).
 *
 * When no key is available, all operations pass through without
 * encryption—zero overhead, identical to a plain `YKeyValueLww<T>`.
 *
 * @example
 * ```typescript
 * // Start in plaintext, transition to encrypted when key arrives
 * const kv = createEncryptedYkvLww<TabData>(yarray);
 * kv.set('tab-1', { url: '...' }); // stored as plaintext
 *
 * kv.activateEncryption(encryptionKey);
 * kv.set('tab-2', { url: '...' }); // stored as EncryptedBlob
 * ```
 */
export function createEncryptedYkvLww<T>(
	yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>,
	options?: EncryptedKvLwwOptions,
): YKeyValueLwwEncrypted<T> {
	/**
	 * The inner LWW store that handles all CRDT logic. It sees `EncryptedBlob | T`
	 * as its value type—it doesn't know or care that some values are ciphertext.
	 * Timestamps, conflict resolution, pending/map architecture, and observer
	 * mechanics all live here. We never duplicate any of that logic.
	 */
	const inner = new YKeyValueLww<EncryptedBlob | T>(yarray);

	/**
	 * Decrypted in-memory index. This is the wrapper's own Map that always
	 * contains **plaintext** values. It mirrors `inner.map` but with decrypted
	 * values. The `inner.observe()` handler is the sole writer.
	 *
	 * Table helpers access this via `cachedEntries()` and `cachedSize`.
	 * Not exposed directly—prevents external mutation of the internal cache.
	 */
	const map = new Map<string, YKeyValueLwwEntry<T>>();

	/** Registered change handlers. Receive decrypted change events. */
	const changeHandlers = new Set<YKeyValueLwwChangeHandler<T>>();

	/**
	 * The active encryption key. Seeded from `options.key` at creation,
	 * then updated exclusively via `activateEncryption()`.
	 */
	let currentKey: Uint8Array | undefined = options?.key;

	/**
	 * Conditionally decrypt a value. Handles three cases:
	 * 1. Value is not an `EncryptedBlob` → return as-is (plaintext or migration entry)
	 * 2. No key available → throw (caller is responsible for error containment)
	 * 3. Value is an `EncryptedBlob` + key available → decrypt with AAD and JSON.parse
	 *
	 * AAD binds the ciphertext to its entry key, preventing blob-swapping attacks
	 * where a malicious sync peer moves an encrypted value between KV entries.
	 */
	const maybeDecrypt = (value: EncryptedBlob | T, aad: Uint8Array): T => {
		if (!isEncryptedBlob(value)) return value as T;
		if (!currentKey) throw new Error('Missing encryption key');
		return JSON.parse(decryptValue(value, currentKey, aad)) as T;
	};

	/**
	 * Compare two decrypted values for equality. Used by `activateEncryption()` to
	 * determine whether an entry's decrypted value actually changed (to avoid
	 * emitting no-op 'update' events). Falls back to JSON.stringify comparison
	 * when Object.is fails (handles deep object equality).
	 *
	 * All values in `map` originated from `JSON.parse(decryptValue(...))`, so
	 * they are guaranteed JSON-safe. JSON.stringify will not throw.
	 */
	const areValuesEqual = (left: T, right: T): boolean => {
		if (Object.is(left, right)) return true;
		return JSON.stringify(left) === JSON.stringify(right);
	};

	/**
	 * Attempt to decrypt an entry. On success, returns the decrypted entry.
	 * On failure, returns `undefined`.
	 *
	 * Used during initialization, observer processing, and `activateEncryption()` rebuild.
	 */
	const tryDecryptEntry = (
		key: string,
		entry: YKeyValueLwwEntry<EncryptedBlob | T>,
	): YKeyValueLwwEntry<T> | undefined => {
		const { data: decryptedVal, error: decryptError } = trySync({
			try: () => maybeDecrypt(entry.val, textEncoder.encode(key)),
			catch: (e) => {
				console.warn(`[encrypted-kv] Failed to decrypt entry "${key}":`, e);
				return Ok(undefined);
			},
		});

		if (decryptError || decryptedVal === undefined) {
			return undefined;
		}

		return { ...entry, val: decryptedVal };
	};

	/**
	 * Decrypt a raw value from inner, returning plaintext or undefined.
	 * Used by `get()` as a fallback when wrapper.map doesn't have the entry
	 * yet (transaction gap between set() and observer firing).
	 */
	const decryptRawValue = (raw: EncryptedBlob | T, aad: Uint8Array): T | undefined => {
		if (!isEncryptedBlob(raw)) return raw as T;
		const key = currentKey;
		if (!key) return undefined;
		const { data } = trySync({
			try: () => JSON.parse(decryptValue(raw, key, aad)) as T,
			catch: () => Ok(undefined),
		});
		return data;
	};

	// Initialize wrapper.map from inner.map (decrypt any pre-existing entries)
	for (const [key, entry] of inner.map) {
		const decryptedEntry = tryDecryptEntry(key, entry);
		if (!decryptedEntry) continue;
		map.set(key, decryptedEntry);
	}

	/**
	 * The heart of the wrapper. When `inner`'s observer fires (entry added,
	 * updated, or deleted), we:
	 * 1. Decrypt the new value (skip on failure)
	 * 2. Update `wrapper.map` with the plaintext
	 * 3. Forward decrypted change events to registered handlers
	 *
	 * This keeps `wrapper.map` always in sync with `inner.map` but with
	 * plaintext values. The observer is the sole writer to `map`.
	 */
	inner.observe((changes, transaction) => {
		const decryptedChanges = new Map<string, YKeyValueLwwChange<T>>();

		for (const [key, change] of changes) {
			if (change.action === 'delete') {
				map.delete(key);
				decryptedChanges.set(key, { action: 'delete' });
			} else {
				const entry = inner.map.get(key);
				if (!entry) continue;

				const decrypted = tryDecryptEntry(key, entry);
				if (!decrypted) continue;

				const wasNew = !map.has(key);
				map.set(key, decrypted);
				decryptedChanges.set(key, {
					action: wasNew ? 'add' : 'update',
					newValue: decrypted.val,
				});
			}
		}

		for (const handler of changeHandlers)
			handler(decryptedChanges, transaction);
	});

	return {
		set(key, val) {
			if (!currentKey) {
				inner.set(key, val);
				return;
			}
			inner.set(key, encryptValue(JSON.stringify(val), currentKey, textEncoder.encode(key)));
		},

		/**
		 * Get a decrypted value by key. O(1) via wrapper.map cache when
		 * the observer has processed the entry. Falls back to decrypting
		 * `inner.get()` on the fly during the transaction gap (after set()
		 * but before observer fires). XChaCha20-Poly1305 decrypt is microseconds.
		 */
		get(key) {
			// Fast path: check decrypted cache (covers post-observer reads)
			const cached = map.get(key);
			if (cached) return cached.val;

			// Fallback: inner may have a pending value the observer hasn't
			// processed yet. Decrypt on the fly.
			const raw = inner.get(key);
			if (raw === undefined) return undefined;
			return decryptRawValue(raw, textEncoder.encode(key));
		},

		/**
		 * Check if key exists with a decryptable value. Returns false for
		 * entries that failed to decrypt (consistent with get() returning undefined).
		 */
		has(key) {
			if (map.has(key)) return true;
			// Check inner for pending values not yet in wrapper.map
			const raw = inner.get(key);
			if (raw === undefined) return false;
			return decryptRawValue(raw, textEncoder.encode(key)) !== undefined;
		},

		delete(key) {
			map.delete(key);
			inner.delete(key);
		},

		*entries() {
			// Yield from inner.entries() (includes pending values during transaction gap),
			// decrypting on the fly. Prefer wrapper.map cache when available.
			for (const [key, entry] of inner.entries()) {
				const cached = map.get(key);
				if (cached) {
					yield [key, cached];
				} else {
					const val = decryptRawValue(entry.val, textEncoder.encode(key));
					if (val !== undefined) yield [key, { ...entry, val }];
				}
			}
		},

		observe(handler) {
			changeHandlers.add(handler);
		},
		unobserve(handler) {
			changeHandlers.delete(handler);
		},

		/**
		 * Activate encryption with a new encryption key. Rebuilds the decrypted map
		 * from scratch and fires synthetic change events for any values
		 * that changed.
		 *
		 * @param nextKey - A 32-byte encryption key
		 */
		activateEncryption(nextKey) {
			currentKey = nextKey;

			const oldMap = new Map(map);

			map.clear();

			for (const [key, entry] of inner.map) {
				const decryptedEntry = tryDecryptEntry(key, entry);
				if (!decryptedEntry) continue;
				map.set(key, decryptedEntry);
			}

			for (const [entryKey, entry] of inner.map) {
				if (isEncryptedBlob(entry.val)) continue;
				inner.set(entryKey, encryptValue(JSON.stringify(entry.val), nextKey, textEncoder.encode(entryKey)));
			}

			// Compute synthetic change events by diffing old vs new map
			const syntheticChanges = new Map<string, YKeyValueLwwChange<T>>();
			const allKeys = new Set<string>([...oldMap.keys(), ...map.keys()]);

			for (const key of allKeys) {
				const oldEntry = oldMap.get(key);
				const newEntry = map.get(key);

				if (!oldEntry && newEntry) {
					syntheticChanges.set(key, { action: 'add', newValue: newEntry.val });
					continue;
				}

				if (oldEntry && !newEntry) {
					syntheticChanges.set(key, { action: 'delete' });
					continue;
				}

				if (!oldEntry || !newEntry) continue;
				if (areValuesEqual(oldEntry.val, newEntry.val)) continue;

				syntheticChanges.set(key, {
					action: 'update',
					newValue: newEntry.val,
				});
			}

			if (syntheticChanges.size === 0) return;

			for (const handler of changeHandlers)
				handler(syntheticChanges, SYNTHETIC_TRANSACTION);
		},

		deactivateEncryption() {
			currentKey = undefined;
			map.clear();
		},
		get failedDecryptCount() {
			return inner.map.size - map.size;
		},
		*cachedEntries() {
			yield* map.entries();
		},
		get cachedSize() {
			return map.size;
		},
		yarray: inner.yarray,
		doc: inner.doc,
	};
}
