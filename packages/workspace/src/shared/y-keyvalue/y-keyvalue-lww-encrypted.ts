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
 *   ├── JSON.stringify → encryptValue → EncryptedBlob
 *   └── inner.set('tab-1', encryptedBlob)              ← CRDT source of truth
 *         │                                                (inner handles pending)
 *         ▼  inner.observe fires
 *   ├── inner.map has encrypted entry
 *   ├── maybeDecrypt → plaintext (or quarantine on failure)
 *   ├── wrapper.map.set('tab-1', plaintext entry)       ← table-helpers read this
 *   └── change event forwarded with decrypted values
 *
 * get('tab-1')
 *   ├── wrapper.map cache hit? → return plaintext        ← fast path (post-observer)
 *   └── inner.get() → decrypt on the fly                ← transaction gap fallback
 * ```
 *
 * ## Three-Mode State Machine
 *
 * ```
 *                     ┌─────────────┐
 *         (creation,  │  PLAINTEXT  │  (no key ever seen)
 *          no key)    │  rw plain   │
 *                     └──────┬──────┘
 *                            │ onKeyChange(key)
 *                            ▼
 *                     ┌─────────────┐
 *                     │  UNLOCKED   │  (key active)
 *                     │  rw encrypt │◄── onKeyChange(newKey)
 *                     └──────┬──────┘
 *                            │ onKeyChange(undefined)
 *                            ▼
 *                     ┌─────────────┐
 *                     │   LOCKED    │  (key was active, now cleared)
 *                     │  r-only     │
 *                     └──────┬──────┘
 *                            │ onKeyChange(key)
 *                            ▼
 *                     ┌─────────────┐
 *                     │  UNLOCKED   │  (re-sign-in)
 *                     └─────────────┘
 * ```
 *
 * - **plaintext**: No key ever seen. Reads and writes pass through unencrypted.
 * - **unlocked**: Key active. `set()` encrypts, observer decrypts.
 * - **locked**: Key was active but cleared (sign-out). `set()` throws to prevent
 *   plaintext overwriting ciphertext. `get()` returns cached plaintext values.
 *
 * `plaintext` → `locked` never happens. `locked` means "was unlocked before."
 * A workspace that never had a key stays `plaintext` through sign-out.
 *
 * ## Key Management
 *
 * The encryption key is managed through a single mechanism: `onKeyChange(key)`.
 * The optional `getKey` getter in options is called **once** at creation to seed
 * the initial key (and therefore the initial mode). After creation, all key
 * transitions go through `onKeyChange()`.
 *
 * ## Pending State
 *
 * The wrapper does NOT maintain its own pending/pendingDeletes maps. The inner
 * `YKeyValueLww` handles all pending logic. During the transaction gap (after
 * `set()` but before the observer fires), `get()` falls back to `inner.get()`
 * and decrypts on the fly. AES-GCM decrypt of a small JSON blob is microseconds—
 * caching this in a separate pending map is unnecessary indirection.
 *
 * ## Error Containment
 *
 * The observer wraps `maybeDecrypt` with `trySync`. A failed decrypt quarantines
 * the entry (stored in `quarantine` map) and logs a warning instead of throwing.
 * This prevents one bad blob from crashing all observation. Quarantined entries
 * are retried on `onKeyChange()` when the correct key arrives.
 *
 * ## Related Modules
 *
 * - {@link ../crypto/index.ts} — Encryption primitives (encryptValue, decryptValue, isEncryptedBlob)
 * - {@link ../crypto/key-cache.ts} — Platform-agnostic key caching (survives page refresh)
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

/**
 * Options for `createEncryptedKvLww`.
 *
 * `getKey` is called **once** at creation to seed the initial encryption key
 * and determine the starting mode (`plaintext` if undefined, `unlocked` if a
 * key is returned). After creation, use `onKeyChange()` for all key transitions.
 */
type EncryptedKvLwwOptions = {
	getKey?: () => Uint8Array | undefined;
};

/** The three encryption modes. See module JSDoc for the full state machine. */
export type EncryptionMode = 'plaintext' | 'locked' | 'unlocked';

/**
 * Return type of `createEncryptedKvLww`. Same API surface as `YKeyValueLww<T>`
 * plus encryption-specific members (`mode`, `quarantine`, `onKeyChange`).
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
	 * Transition the encryption key. This is the **sole mechanism** for key
	 * changes after creation. Rebuilds `map` from `inner.map`, retries
	 * quarantined entries, transitions mode, and fires synthetic change events.
	 *
	 * @param key - New key (`unlocked`) or `undefined` (`locked` / stay `plaintext`)
	 */
	onKeyChange(key: Uint8Array | undefined): void;

	/** Current encryption mode. Derived from key presence history. */
	readonly mode: EncryptionMode;

	/**
	 * Entries that failed to decrypt. Stored as raw `EncryptedBlob | T` entries
	 * from `inner.map`. Retried automatically on `onKeyChange()` when the
	 * correct key arrives. Exposed so table helpers can show a
	 * "N entries failed to decrypt" warning.
	 */
	readonly quarantine: ReadonlyMap<
		string,
		YKeyValueLwwEntry<EncryptedBlob | T>
	>;

	/**
	 * Decrypted in-memory index. Always contains **plaintext** values.
	 *
	 * This exists because `table-helper.ts` methods (`getAll()`, `filter()`,
	 * `find()`, `count()`, `clear()`) read `ykv.map` directly—they don't call
	 * `get()` per entry. If we exposed `inner.map`, table helpers would see
	 * `EncryptedBlob` objects where they expect row data. Schema validation
	 * would fail on every entry.
	 *
	 * Kept in sync by `inner.observe()`—the observer is the sole writer,
	 * mirroring the same single-writer pattern that `YKeyValueLww` itself uses.
	 */
	readonly map: Map<string, YKeyValueLwwEntry<T>>;

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
 * When no key is available (plaintext mode), all operations pass through without
 * encryption—zero overhead, identical to a plain `YKeyValueLww<T>`.
 *
 * @example
 * ```typescript
 * // Start in plaintext, transition to encrypted when key arrives
 * const kv = createEncryptedKvLww<TabData>(yarray);
 * kv.mode; // 'plaintext'
 * kv.set('tab-1', { url: '...' }); // stored as plaintext
 *
 * kv.onKeyChange(encryptionKey);
 * kv.mode; // 'unlocked'
 * kv.set('tab-2', { url: '...' }); // stored as EncryptedBlob
 *
 * kv.onKeyChange(undefined);
 * kv.mode; // 'locked'
 * kv.set('tab-3', ...); // throws: "Workspace is locked"
 * kv.get('tab-1'); // still returns cached plaintext
 * ```
 */
export function createEncryptedKvLww<T>(
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
	 * Why a separate map? `table-helper.ts` reads `ykv.map` directly for
	 * `getAll()`, `filter()`, `find()`, `count()`. If we exposed `inner.map`,
	 * those methods would see `EncryptedBlob` objects and schema validation
	 * would fail. This map ensures table helpers see plaintext—zero changes
	 * to table-helper.ts.
	 */
	const map = new Map<string, YKeyValueLwwEntry<T>>();

	/** Registered change handlers. Receive decrypted change events. */
	const changeHandlers = new Set<YKeyValueLwwChangeHandler<T>>();

	/**
	 * Entries that failed to decrypt. Stored as raw entries from `inner.map`.
	 * Retried on `onKeyChange()` when a new key arrives.
	 */
	const quarantine = new Map<string, YKeyValueLwwEntry<EncryptedBlob | T>>();

	/**
	 * The active encryption key. Seeded from `getKey()` at creation (called once),
	 * then updated exclusively via `onKeyChange()`.
	 */
	let currentKey: Uint8Array | undefined = options?.getKey?.();

	/**
	 * Current encryption mode. Derived from key presence history:
	 * - `plaintext`: No key has ever been seen (initial state when getKey() → undefined)
	 * - `unlocked`: A key is currently active
	 * - `locked`: A key was active but has been cleared (sign-out)
	 */
	let mode: EncryptionMode = currentKey ? 'unlocked' : 'plaintext';

	/**
	 * Conditionally decrypt a value. Handles three cases:
	 * 1. Value is not an `EncryptedBlob` → return as-is (plaintext or migration entry)
	 * 2. No key available → throw (caller is responsible for error containment)
	 * 3. Value is an `EncryptedBlob` + key available → decrypt and JSON.parse
	 */
	const maybeDecrypt = (value: EncryptedBlob | T): T => {
		if (!isEncryptedBlob(value)) return value as T;
		if (!currentKey) throw new Error('Missing encryption key');
		return JSON.parse(decryptValue(value, currentKey)) as T;
	};

	/**
	 * Compare two decrypted values for equality. Used by `onKeyChange()` to
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
	 * Attempt to decrypt an entry. On success, removes from quarantine and
	 * returns the decrypted entry. On failure, quarantines the entry and
	 * returns `undefined`.
	 *
	 * Used during initialization, observer processing, and `onKeyChange()` rebuild.
	 */
	const tryDecryptEntry = (
		key: string,
		entry: YKeyValueLwwEntry<EncryptedBlob | T>,
	): YKeyValueLwwEntry<T> | undefined => {
		const { data: decryptedVal, error: decryptError } = trySync({
			try: () => maybeDecrypt(entry.val),
			catch: (e) => {
				console.warn(`[encrypted-kv] Failed to decrypt entry "${key}":`, e);
				return Ok(undefined);
			},
		});

		if (decryptError || decryptedVal === undefined) {
			quarantine.set(key, entry);
			return undefined;
		}

		quarantine.delete(key);
		return { ...entry, val: decryptedVal };
	};

	/**
	 * Decrypt a raw value from inner, returning plaintext or undefined.
	 * Used by `get()` as a fallback when wrapper.map doesn't have the entry
	 * yet (transaction gap between set() and observer firing).
	 */
	const decryptRawValue = (raw: EncryptedBlob | T): T | undefined => {
		if (!isEncryptedBlob(raw)) return raw as T;
		const key = currentKey;
		if (!key) return undefined;
		const { data } = trySync({
			try: () => JSON.parse(decryptValue(raw, key)) as T,
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
	 * 1. Decrypt the new value (quarantine on failure)
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
				quarantine.delete(key);
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
			if (mode === 'locked')
				throw new Error('Workspace is locked — sign in to write');

			if (mode === 'plaintext') {
				inner.set(key, val);
				return;
			}

			if (!currentKey)
				throw new Error('Workspace is locked — sign in to write');
			inner.set(key, encryptValue(JSON.stringify(val), currentKey));
		},

		/**
		 * Get a decrypted value by key. O(1) via wrapper.map cache when
		 * the observer has processed the entry. Falls back to decrypting
		 * `inner.get()` on the fly during the transaction gap (after set()
		 * but before observer fires). AES-GCM decrypt is microseconds.
		 */
		get(key) {
			// Fast path: check decrypted cache (covers post-observer reads)
			const cached = map.get(key);
			if (cached) return cached.val;

			// Fallback: inner may have a pending value the observer hasn't
			// processed yet. Decrypt on the fly.
			const raw = inner.get(key);
			if (raw === undefined) return undefined;
			return decryptRawValue(raw);
		},

		/**
		 * Check if key exists with a decryptable value. Returns false for
		 * quarantined entries (consistent with get() returning undefined).
		 */
		has(key) {
			if (map.has(key)) return true;
			// Check inner for pending values not yet in wrapper.map
			const raw = inner.get(key);
			if (raw === undefined) return false;
			return decryptRawValue(raw) !== undefined;
		},

		delete(key) {
			map.delete(key);
			quarantine.delete(key);
			inner.delete(key);
		},

		*entries() {
			const yieldedKeys = new Set<string>();

			// Yield from inner.entries() (includes pending values during transaction gap),
			// decrypting on the fly. Prefer wrapper.map cache when available.
			for (const [key, entry] of inner.entries()) {
				yieldedKeys.add(key);
				const cached = map.get(key);
				if (cached) {
					yield [key, cached];
				} else {
					const val = decryptRawValue(entry.val);
					if (val !== undefined) yield [key, { ...entry, val }];
				}
			}

			// Yield any wrapper.map entries not in inner (shouldn't happen, but safe)
			for (const [key, entry] of map)
				if (!yieldedKeys.has(key)) yield [key, entry];
		},

		observe(handler) {
			changeHandlers.add(handler);
		},
		unobserve(handler) {
			changeHandlers.delete(handler);
		},

		/**
		 * Transition the encryption key and rebuild the decrypted map.
		 *
		 * Mode transitions:
		 * - `key` provided → `unlocked` (rebuild map with new key, fire synthetic events)
		 * - `undefined` + was `unlocked`/`locked` → `locked` (freeze cache, no rebuild)
		 * - `undefined` + was `plaintext` → stays `plaintext` (no-op)
		 *
		 * Locking preserves the existing decrypted cache—you lose write access,
		 * not read access. Only unlocking triggers a full map rebuild.
		 */
		onKeyChange(nextKey) {
			currentKey = nextKey;

			// Lock transition: freeze current state, don't rebuild
			if (!nextKey) {
				if (mode !== 'plaintext') mode = 'locked';
				return;
			}

			// Unlock transition: rebuild decrypted map with new key
			const oldMap = new Map(map);
			mode = 'unlocked';

			map.clear();
			quarantine.clear();

			for (const [key, entry] of inner.map) {
				const decryptedEntry = tryDecryptEntry(key, entry);
				if (!decryptedEntry) continue;
				map.set(key, decryptedEntry);
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

			// Synthetic events have no real Y.Transaction — onKeyChange is not a Yjs operation.
			// Handlers that only read the changes map (all current consumers) are unaffected.
			const syntheticTransaction = undefined as unknown as Y.Transaction;
			for (const handler of changeHandlers)
				handler(syntheticChanges, syntheticTransaction);
		},
		get mode() {
			return mode;
		},
		get quarantine() {
			return quarantine;
		},
		map,
		yarray: inner.yarray,
		doc: inner.doc,
	};
}
