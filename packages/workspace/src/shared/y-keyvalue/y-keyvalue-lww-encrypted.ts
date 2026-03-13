/**
 * # Encrypted KV-LWW — Composition Wrapper
 *
 * Transparent encryption layer over `YKeyValueLww`. This is a ~130-line
 * wrapper, not a fork. All CRDT logic (timestamps, conflict resolution,
 * pending/map architecture) stays in `YKeyValueLww`; this module only
 * transforms values at the boundary.
 *
 * ## Why Composition Over Fork
 *
 * Yjs `ContentAny` stores entry objects by **reference**. `YKeyValueLww`
 * relies on `indexOf()` (strict `===`) to find entries in the Y.Array
 * during conflict resolution. A fork that decrypts into new objects
 * breaks `indexOf`—the map entries are no longer the same JS objects
 * as the yarray entries. Empirically verified with 8 experiments.
 *
 * See `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`.
 *
 * ## Data Flow
 *
 * ```
 * set('tab-1', { url: '...' })
 *   ├── wrapper.pending.set('tab-1', plaintext entry)  ← immediate reads
 *   ├── JSON.stringify → encryptValue → EncryptedBlob
 *   └── inner.set('tab-1', encryptedBlob)              ← CRDT source of truth
 *         │
 *         ▼  inner.observe fires
 *   ├── inner.map has encrypted entry
 *   ├── maybeDecrypt → plaintext
 *   ├── wrapper.map.set('tab-1', plaintext entry)       ← table-helpers read this
 *   └── wrapper.pending.delete('tab-1')
 * ```
 *
 * ## Key Delivery
 *
 * The 32-byte AES-256-GCM key arrives via the auth flow:
 *
 * | Mode              | Key source                                        |
 * |-------------------|---------------------------------------------------|
 * | Epicenter Cloud   | Server derives from `BETTER_AUTH_SECRET` via SHA-256 |
 * | Self-hosted       | User password → PBKDF2 (600k iterations) → key   |
 * | Local / no auth   | `getKey()` returns undefined → plaintext passthrough |
 *
 * `getKey` is a **getter function** (not a static value) because the workspace
 * is created eagerly as a module-level export before auth completes. The getter
 * is called on every operation, so encryption activates the moment a key arrives.
 *
 * @see {@link ./y-keyvalue-lww.ts} for the underlying CRDT implementation
 * @see {@link ../crypto/index.ts} for the encryption primitives
 *
 * @module
 */
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
 * `getKey` is intentionally a getter, not a static key. The workspace object is
 * constructed at module scope—before auth completes and before the encryption key
 * is available. A static key would force recreation of the wrapper (and all its
 * observers) every time the key changes. The getter is called on each `set()`/`get()`,
 * so encryption activates transparently the moment the key becomes available.
 */
type EncryptedKvLwwOptions = { getKey?: () => Uint8Array | undefined };

/**
 * Return type of `createEncryptedKvLww`. Same API surface as `YKeyValueLww<T>`
 * so it's a drop-in replacement. All values exposed through this type are
 * **plaintext**—encryption is fully transparent to consumers.
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
 * When `getKey()` returns `undefined`, all operations pass through without
 * encryption—zero overhead, identical to a plain `YKeyValueLww<T>`.
 *
 * @example
 * ```typescript
 * // Cloud mode: key from auth session
 * const kv = createEncryptedKvLww<TabData>(yarray, {
 *   getKey: () => sessionStore.encryptionKey,
 * });
 * kv.set('tab-1', { url: 'https://bank.com', title: 'My Bank' });
 * kv.get('tab-1'); // { url: 'https://bank.com', title: 'My Bank' }
 * // Y.Array contains: { key: 'tab-1', val: { v: 1, ct: '...' }, ts: ... }
 *
 * // No-key passthrough: identical to plain YKeyValueLww
 * const plainKv = createEncryptedKvLww<string>(yarray);
 * plainKv.set('theme', 'dark');
 * // Y.Array contains: { key: 'theme', val: 'dark', ts: ... }
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

	/**
	 * Plaintext values written by `set()` but not yet processed by the observer.
	 *
	 * Mirrors `YKeyValueLww`'s own pending pattern. When `set()` is called
	 * inside a batch/transaction, the observer doesn't fire until the outer
	 * transaction ends. Without this, `get()` would return `undefined` for
	 * values just written. The observer clears entries from here as it
	 * processes them.
	 */
	const pending = new Map<string, YKeyValueLwwEntry<T>>();

	/**
	 * Keys deleted by `delete()` but not yet processed by the observer.
	 *
	 * Symmetric counterpart to `pending`. Prevents stale reads from `map`
	 * after `delete()` during a batch/transaction. Cleared by the observer
	 * when the deletion is processed.
	 */
	const pendingDeletes = new Set<string>();

	/** Registered change handlers. Receive decrypted change events. */
	const changeHandlers = new Set<YKeyValueLwwChangeHandler<T>>();

	/** Resolved key getter. Returns `undefined` when no key is available. */
	const getKey = options?.getKey ?? (() => undefined);

	/**
	 * Conditionally decrypt a value. Handles three cases:
	 * 1. No key available → return value as-is (passthrough mode)
	 * 2. Value is an `EncryptedBlob` → decrypt and JSON.parse
	 * 3. Value is plaintext → return as-is (migration: pre-encryption entries)
	 */
	const maybeDecrypt = (value: EncryptedBlob | T): T => {
		const key = getKey();
		if (!key || !isEncryptedBlob(value)) return value as T;
		return JSON.parse(decryptValue(value, key)) as T;
	};

	// Initialize wrapper.map from inner.map (decrypt any pre-existing entries)
	for (const [key, entry] of inner.map)
		map.set(key, { ...entry, val: maybeDecrypt(entry.val) });

	/**
	 * The heart of the wrapper. When `inner`'s observer fires (entry added,
	 * updated, or deleted), we:
	 * 1. Decrypt the new value
	 * 2. Update `wrapper.map` with the plaintext
	 * 3. Clear corresponding `pending`/`pendingDeletes` entries
	 * 4. Forward decrypted change events to registered handlers
	 *
	 * This keeps `wrapper.map` always in sync with `inner.map` but with
	 * plaintext values. The observer is the sole writer to `map`.
	 */
	inner.observe((changes, transaction) => {
		const decryptedChanges = new Map<string, YKeyValueLwwChange<T>>();
		for (const [key, change] of changes) {
			if (change.action === 'delete') {
				map.delete(key);
				decryptedChanges.set(key, {
					action: 'delete',
					oldValue: maybeDecrypt(change.oldValue),
				});
			} else {
				const entry = inner.map.get(key);
				if (!entry) continue;
				const decryptedVal = maybeDecrypt(entry.val);
				map.set(key, { ...entry, val: decryptedVal });
				if (change.action === 'add')
					decryptedChanges.set(key, { action: 'add', newValue: decryptedVal });
				else
					decryptedChanges.set(key, {
						action: 'update',
						oldValue: maybeDecrypt(change.oldValue),
						newValue: decryptedVal,
					});
			}
			pending.delete(key);
			pendingDeletes.delete(key);
		}
		for (const handler of changeHandlers)
			handler(decryptedChanges, transaction);
	});

	return {
		set(key, val) {
			pendingDeletes.delete(key);
			pending.set(key, { key, val, ts: Date.now() });
			const keyBytes = getKey();
			if (!keyBytes) return inner.set(key, val);
			inner.set(key, encryptValue(JSON.stringify(val), keyBytes));
		},
		get(key) {
			if (pendingDeletes.has(key)) return undefined;
			return pending.get(key)?.val ?? map.get(key)?.val;
		},
		has(key) {
			return inner.has(key);
		},
		delete(key) {
			pending.delete(key);
			pendingDeletes.add(key);
			map.delete(key);
			inner.delete(key);
		},
		*entries() {
			const yieldedKeys = new Set<string>();
			for (const [key, entry] of pending) {
				yieldedKeys.add(key);
				yield [key, entry];
			}
			for (const [key, entry] of map)
				if (!yieldedKeys.has(key) && !pendingDeletes.has(key))
					yield [key, entry];
		},
		observe(handler) {
			changeHandlers.add(handler);
		},
		unobserve(handler) {
			changeHandlers.delete(handler);
		},
		map,
		yarray: inner.yarray,
		doc: inner.doc,
	};
}
