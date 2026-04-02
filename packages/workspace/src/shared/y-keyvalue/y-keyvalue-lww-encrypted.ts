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
 *   ├── tryDecryptEntry → plaintext (or skip on failure)
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
 * Encryption is governed by a single `encryption` state struct. There is no separate
 * state variable—encryption state is derived from `encryption !== undefined`.
 *
 * ```
 *   Keyring provided (activateEncryption)
 *   ┌──────────────────┐       ┌──────────────────┐
 *   │  keyring: present    │◄── activateEncryption(keyring)
 *   │  rw plaintext      │       │  rw encrypted      │
 *   └──────────────────┘       └──────────────────┘
 * ```
 *
 * - **No keyring**: Reads and writes pass through unencrypted.
 * - **Keyring present**: `set()` encrypts with current (highest-version) key, observer decrypts.
 *
 * ## Key Management
 *
 * The encryption keyring is managed through `activateEncryption(keyring)`. The optional
 * `initialKeyring` parameter seeds the initial keyring at construction time. After creation,
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
 * The observer wraps decrypt with try/catch. A failed decrypt skips
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
import type * as Y from 'yjs';
import {
	decryptValue,
	type EncryptedBlob,
	encryptValue,
	getKeyVersion,
	isEncryptedBlob,
} from '../crypto';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from './y-keyvalue-lww';

const textEncoder = new TextEncoder();

/** Transaction origin for re-encryption writes. Observer skips events with this origin. */
const RE_ENCRYPT = Symbol('re-encrypt');

/**
 * Change handler for the encrypted KV wrapper.
 *
 * Receives the Yjs transaction origin for real CRDT changes, or `undefined`
 * for encryption lifecycle events (activateEncryption, deactivateEncryption)
 * which have no backing Yjs transaction.
 */
export type EncryptedKvChangeHandler<T> = (
	changes: Map<string, YKeyValueLwwChange<T>>,
	origin: unknown,
) => void;


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
	observe(handler: EncryptedKvChangeHandler<T>): void;
	unobserve(handler: EncryptedKvChangeHandler<T>): void;

	/**
	 * Activate encryption with a keyring. The highest-version key becomes
	 * the current key for all new encryptions. Decryption reads `getKeyVersion(blob)`
	 * to select the correct key from the keyring.
	 *
	 * @param keyring - Map from version number to 32-byte encryption key
	 */
	activateEncryption(keyring: ReadonlyMap<number, Uint8Array>): void;

	/**
	 * Deactivate encryption. Clears the key, emits delete events for entries
	 * that become unreadable, and retains any plaintext entries.
	 */
	deactivateEncryption(): void;
	/**
	 * Number of entries in the inner store that are not in the decrypted cache.
	 * When a key is active, this counts entries that failed to decrypt.
	 * When no key is active, this counts all encrypted entries (they are not
	 * "failed"—they are waiting for a key). Entries are retried on
	 * `activateEncryption()`.
	 *
	 * Computed as `inner.map.size - map.size`.
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
 * kv.activateEncryption(new Map([[1, encryptionKey]]));
 * kv.set('tab-2', { url: '...' }); // stored as EncryptedBlob
 * ```
 */
export function createEncryptedYkvLww<T>(
	yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>,
	initialKeyring?: ReadonlyMap<number, Uint8Array>,
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
	const changeHandlers = new Set<EncryptedKvChangeHandler<T>>();

	/**
	 * Active encryption state. When defined, `set()` encrypts and the observer
	 * decrypts. When `undefined`, all operations pass through as plaintext.
	 *
	 * Collapsed into a single struct so activation/deactivation is atomic—
	 * no risk of updating `currentKey` but forgetting `activeKeyring`.
	 */
	let encryption: {
		keyring: ReadonlyMap<number, Uint8Array>;
		currentKey: Uint8Array;
		currentVersion: number;
	} | undefined;

	/**
	 * Decrypt an encrypted blob with version-directed keyring fallback.
	 *
	 * Tries currentKey first (fast path for latest-version blobs).
	 * Falls back to version-directed lookup from activeKeyring when
	 * currentKey fails (handles blobs encrypted with older key versions).
	 * Returns the decrypted JSON string, or undefined on failure.
	 */
	const decryptBlobWithFallback = (
		blob: EncryptedBlob,
		aad: Uint8Array,
	): string | undefined => {
		if (!encryption) return undefined;

		// Fast path: try current key (most blobs are on latest version)
		try {
			return decryptValue(blob, encryption.currentKey, aad);
		} catch { /* fall through to version-directed lookup */ }

		// Version-directed fallback from keyring
		const blobVersion = getKeyVersion(blob);
		const versionKey = encryption.keyring.get(blobVersion);
		if (versionKey && versionKey !== encryption.currentKey) {
			try {
				return decryptValue(blob, versionKey, aad);
			} catch { /* fall through */ }
		}

		return undefined;
	};

	/**
	 * Attempt to decrypt an entry with version-directed keyring fallback.
	 * Logs a warning on total failure for diagnostics.
	 */
	const tryDecryptEntry = (
		key: string,
		entry: YKeyValueLwwEntry<EncryptedBlob | T>,
	): YKeyValueLwwEntry<T> | undefined => {
		if (!isEncryptedBlob(entry.val)) return { ...entry, val: entry.val as T };

		const json = decryptBlobWithFallback(entry.val, textEncoder.encode(key));
		if (!json) {
			console.warn(`[encrypted-kv] Failed to decrypt entry "${key}"`);
			return undefined;
		}
		return { ...entry, val: JSON.parse(json) as T };
	};

	/**
	 * Silent decrypt — returns plaintext value or undefined.
	 *
	 * Used by get(), has(), and entries() for on-the-fly decryption during the
	 * transaction gap (after set() but before the observer fires). Uses the same
	 * version-directed fallback as tryDecryptEntry for consistency.
	 */
	const tryDecryptValue = (raw: EncryptedBlob | T, aad: Uint8Array): T | undefined => {
		if (!isEncryptedBlob(raw)) return raw as T;
		const json = decryptBlobWithFallback(raw, aad);
		if (!json) return undefined;
		return JSON.parse(json) as T;
	};

	/** Clear and rebuild the decrypted cache from inner.map. */
	const rebuildMap = () => {
		map.clear();
		for (const [key, entry] of inner.map) {
			const decryptedEntry = tryDecryptEntry(key, entry);
			if (!decryptedEntry) continue;
			map.set(key, decryptedEntry);
		}
	};

	/** Compare two decrypted values for equality (deep via JSON.stringify fallback). */
	const areValuesEqual = (left: T, right: T): boolean =>
		Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);

	/**
	 * Diff old map vs current map and emit synthetic change events.
	 *
	 * Shared by activateEncryption and deactivateEncryption to ensure
	 * symmetric event emission on all encryption state transitions.
	 */
	const diffAndEmit = (oldMap: Map<string, YKeyValueLwwEntry<T>>) => {
		const changes = new Map<string, YKeyValueLwwChange<T>>();
		const allKeys = new Set([...oldMap.keys(), ...map.keys()]);

		for (const key of allKeys) {
			const oldEntry = oldMap.get(key);
			const newEntry = map.get(key);

			if (!oldEntry && newEntry) {
				changes.set(key, { action: 'add', newValue: newEntry.val });
				continue;
			}

			if (oldEntry && !newEntry) {
				changes.set(key, { action: 'delete' });
				continue;
			}

			if (!oldEntry || !newEntry) continue;
			if (areValuesEqual(oldEntry.val, newEntry.val)) continue;

			changes.set(key, { action: 'update', newValue: newEntry.val });
		}

		if (changes.size === 0) return;
		for (const handler of changeHandlers) handler(changes, undefined);
	};

	// Seed encryption state before initial map build (if provided).
	// No observers exist yet, so no events fire — just sets the state
	// so rebuildMap() can decrypt pre-existing entries.
	if (initialKeyring) {
		if (initialKeyring.size === 0) throw new Error('Keyring must contain at least one key');
		const seedVersion = Math.max(...initialKeyring.keys());
		encryption = {
			keyring: initialKeyring,
			currentKey: initialKeyring.get(seedVersion)!,
			currentVersion: seedVersion,
		};
	}


	// Initialize wrapper.map from inner.map (decrypt any pre-existing entries)
	rebuildMap();

	/**
	 * The heart of the wrapper. When `inner`'s observer fires (entry added,
	 * updated, or deleted), we:
	 * 1. Decrypt the new value (skip on failure)
	 * 2. Update `wrapper.map` with the plaintext
	 * 3. Forward decrypted change events to registered handlers
	 *
	 * This keeps `wrapper.map` always in sync with `inner.map` but with
	 * plaintext values. `activateEncryption` and `deactivateEncryption` also
	 * write to `map` during encryption state transitions.
	 */
	inner.observe((changes, transaction) => {
		// Skip re-encryption writes — they don't change decrypted values.
		// activateEncryption handles its own event emission via diffAndEmit.
		if (transaction.origin === RE_ENCRYPT) return;

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
			handler(decryptedChanges, transaction.origin);
	});

	return {
		set(key, val) {
			if (!encryption) {
				inner.set(key, val);
				return;
			}
			inner.set(key, encryptValue(JSON.stringify(val), encryption.currentKey, textEncoder.encode(key), encryption.currentVersion));
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
			return tryDecryptValue(raw, textEncoder.encode(key));
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
			return tryDecryptValue(raw, textEncoder.encode(key)) !== undefined;
		},

		delete(key) {
			map.delete(key);
			inner.delete(key);
		},

		/**
		 * Iterate all entries with decrypted values. Prefers the wrapper.map cache;
		 * falls back to on-the-fly decryption for entries in the transaction gap
		 * (after set() but before the observer fires).
		 *
		 * Entries that cannot be decrypted (wrong key, corrupted blob, no key active)
		 * are silently omitted. Use `failedDecryptCount` to detect missing entries.
		 */
		*entries() {
			for (const [key, entry] of inner.entries()) {
				const cached = map.get(key);
				if (cached) {
					yield [key, cached];
				} else {
					const val = tryDecryptValue(entry.val, textEncoder.encode(key));
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
		 * Activate encryption with a keyring. The highest version key becomes
		 * the current key for all new encryptions. Decryption uses
		 * `getKeyVersion(blob)` to select the correct key from the keyring.
		 *
		 * Entries encrypted with non-current keys are re-encrypted with the
		 * current key. Plaintext entries are encrypted.
		 *
		 * @param keyring - Map from version number to 32-byte encryption key
		 */
		activateEncryption(keyring) {
			if (keyring.size === 0) throw new Error('Keyring must contain at least one key');

			const nextVersion = Math.max(...keyring.keys());
			const nextKey = keyring.get(nextVersion)!;
			encryption = { keyring, currentKey: nextKey, currentVersion: nextVersion };

			const oldMap = new Map(map);
			map.clear();
			const needsReEncrypt: Array<{ key: string; val: T }> = [];

			for (const [key, entry] of inner.map) {
				const decrypted = tryDecryptEntry(key, entry);
				if (!decrypted) continue;
				map.set(key, decrypted);

				// Re-encrypt plaintext entries and entries on older key versions
				if (!isEncryptedBlob(entry.val) || getKeyVersion(entry.val as EncryptedBlob) !== encryption.currentVersion) {
					needsReEncrypt.push({ key, val: decrypted.val });
				}
			}

			// Re-encrypt only entries that need it (plaintext or old-key)
			inner.doc.transact(() => {
				for (const { key: entryKey, val } of needsReEncrypt) {
					inner.set(entryKey, encryptValue(JSON.stringify(val), nextKey, textEncoder.encode(entryKey), nextVersion));
				}
			}, RE_ENCRYPT);

			diffAndEmit(oldMap);
		},

		/**
		 * Deactivate encryption. Clears the key and emits delete events for
		 * entries that are no longer readable (encrypted entries disappear,
		 * plaintext entries remain visible).
		 */
		deactivateEncryption() {
			encryption = undefined;
			const oldMap = new Map(map);
			map.clear();

			// Plaintext entries survive deactivation
			for (const [key, entry] of inner.map) {
				if (!isEncryptedBlob(entry.val)) {
					map.set(key, { ...entry, val: entry.val as T });
				}
			}

			diffAndEmit(oldMap);
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
