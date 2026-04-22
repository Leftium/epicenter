/**
 * # Encrypted KV-LWW—Composition Wrapper
 *
 * Transparent encryption layer over `YKeyValueLww`. All CRDT logic (timestamps,
 * conflict resolution, pending/map architecture) stays in `YKeyValueLww`; this
 * module transforms values at the boundary.
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
 *
 * get('tab-1')
 *   └── inner.get('tab-1') → decrypt on the fly        ← ~0.01ms per value
 * ```
 *
 * There is no plaintext cache. Every read decrypts from the inner store.
 * XChaCha20-Poly1305 decrypt of a small JSON blob is microseconds—caching
 * adds complexity (dual-map sync, diffAndEmit, transaction-gap fallback)
 * for negligible performance gain.
 *
 * ## Encryption Lifecycle
 *
 * Encryption is **one-way** by API surface—there is no
 * `deactivateEncryption()`. Once `activateEncryption()` is called, the
 * `encryption` state is set and no method clears it. The only reset
 * path is destroying the wrapper via `clearLocalData()`.
 *
 * ## Re-encryption on Activation
 *
 * When `activateEncryption()` is called, every entry converges to the current
 * key version: plaintext is encrypted, old-version ciphertext (decryptable via
 * the keyring) is re-encrypted under the current key, current-version
 * ciphertext is skipped, and ciphertext at an unknown version is left alone
 * (it'll catch up on a future `activateEncryption()` that includes the key).
 * This makes `activateEncryption()` the one method that handles both
 * post-login encryption and key rotation.
 *
 * ## Error Containment
 *
 * The observer wraps decrypt with try/catch. A failed decrypt skips the entry
 * and logs a warning instead of throwing. This prevents one bad blob from
 * crashing all observation. `unreadableEntryCount` exposes the count.
 *
 * ## Related Modules
 *
 * - {@link ../crypto/index.ts}—Encryption primitives (encryptValue, decryptValue, isEncryptedBlob)
 * - {@link ./y-keyvalue-lww.ts}—Inner CRDT that handles conflict resolution (unaware of encryption)
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
} from '../crypto/index.js';
import {
	type KvStoreChange,
	type KvStoreChangeHandler,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../../document/y-keyvalue/index.js';

const textEncoder = new TextEncoder();
/** Transaction origin for re-encryption writes. Observer skips events with this origin. */
const REENCRYPT_ORIGIN = Symbol('re-encrypt');

type EncryptionState = {
	keyring: ReadonlyMap<number, Uint8Array>;
	currentKey: Uint8Array;
	currentVersion: number;
};

/**
 * Return type of `createEncryptedYkvLww`.
 *
 * IS-A `ObservableKvStore<T>` (the shared contract) plus encryption lifecycle
 * (`activateEncryption`, `unreadableEntryCount`), disposal, and direct access
 * to the underlying `yarray` / `doc` for sync providers.
 *
 * All values exposed through the `ObservableKvStore` surface are **plaintext** —
 * encryption is transparent to consumers.
 */
export type EncryptedYKeyValueLww<T> = ObservableKvStore<T> & {
	/**
	 * Activate encryption with a versioned keyring. The highest-version key
	 * becomes the current key for new encryptions. Decryption reads
	 * `getKeyVersion(blob)` to select the correct key from the keyring.
	 *
	 * There is no deactivation path — this is one-way by API surface. Calling
	 * again with a new keyring updates the active keys AND re-encrypts any
	 * entries that aren't already at the current key version.
	 *
	 * After this call, every decryptable entry is stored as ciphertext under
	 * the current-version key:
	 *
	 * - Plaintext entries → encrypted with the current-version key.
	 * - Ciphertext at a non-current version (decryptable via the keyring) →
	 *   decrypted and re-encrypted with the current-version key. This is how
	 *   key rotation upgrades at-rest data.
	 * - Ciphertext already at the current version → no-op.
	 * - Ciphertext whose key version is not in the keyring → skipped
	 *   (unreadable; left unchanged).
	 *
	 * @param keyring Map from version number to 32-byte encryption key
	 */
	activateEncryption(keyring: ReadonlyMap<number, Uint8Array>): void;

	/**
	 * Unregister the inner observer and release resources. Call when this
	 * wrapper is no longer needed but the underlying Y.Array continues to exist.
	 */
	dispose(): void;

	/**
	 * Number of entries in the inner store that cannot be decrypted.
	 *
	 * When a key is active, this counts entries that failed to decrypt
	 * (corrupted blobs, wrong key version not in keyring). When no key
	 * is active, this counts all encrypted entries.
	 *
	 * Computed by iterating `inner.map` and counting undecryptable entries.
	 */
	readonly unreadableEntryCount: number;

	/** The underlying Y.Array. Contains **ciphertext** when a key is active. */
	readonly yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>;

	/** The Y.Doc that owns the array. */
	readonly doc: Y.Doc;
};

/**
 * Compose transparent encryption onto `YKeyValueLww` without forking CRDT logic.
 *
 * `YKeyValueLww` remains the single source for conflict resolution; this wrapper
 * only transforms values at the boundary (`set` encrypts, `get`/observer decrypts).
 *
 * Construction always starts in passthrough mode — zero overhead, identical to
 * a plain `YKeyValueLww<T>`. Call `activateEncryption(keyring)` when the key
 * becomes available (typically post-login) to enable encryption and upgrade
 * any existing plaintext or old-version entries.
 *
 * @example
 * ```typescript
 * const kv = createEncryptedYkvLww<TabData>(ydoc, 'tabs');
 * kv.set('tab-1', { url: '...' }); // stored as plaintext
 *
 * kv.activateEncryption(new Map([[1, encryptionKey]]));
 * kv.set('tab-2', { url: '...' }); // stored as EncryptedBlob
 * // tab-1 was re-encrypted during activation
 * ```
 *
 * @param ydoc - The Y.Doc that owns the underlying Y.Array
 * @param arrayKey - Name of the Y.Array under `ydoc.getArray(arrayKey)`
 */
export function createEncryptedYkvLww<T>(
	ydoc: Y.Doc,
	arrayKey: string,
): EncryptedYKeyValueLww<T> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | T>>(arrayKey);
	/**
	 * The inner LWW store. It sees `EncryptedBlob | T` as its value type—it
	 * doesn't know or care that some values are ciphertext. Timestamps, conflict
	 * resolution, and observer mechanics all live here.
	 */
	const inner = new YKeyValueLww<EncryptedBlob | T>(yarray);
	const changeHandlers = new Set<KvStoreChangeHandler<T>>();

	/** Active encryption state. `undefined` = passthrough mode. */
	let encryption: EncryptionState | undefined;

	/**
	 * Best-effort blob decryption with keyring fallback.
	 *
	 * Tries currentKey first (most blobs use the latest version).
	 * On failure, reads the blob's embedded key version and tries
	 * the matching key from the keyring.
	 *
	 * Pure function—no logging, no side effects. Callers decide
	 * what to do with `undefined` (warn, skip, etc.).
	 *
	 * @param state - Defaults to the closure's `encryption`. Overridden by
	 *   `activateEncryption()` to compare before/after readability without
	 *   mutating the closure mid-iteration.
	 */
	const tryDecryptBlob = (
		blob: EncryptedBlob,
		aad: Uint8Array,
		state: EncryptionState | undefined = encryption,
	): string | undefined => {
		if (!state) return undefined;
		try {
			return decryptValue(blob, state.currentKey, aad);
		} catch {
			// Current key didn't work — try the blob's recorded key version
		}
		const versionKey = state.keyring.get(getKeyVersion(blob));
		if (!versionKey || versionKey === state.currentKey) return undefined; // Missing version, or same key we already tried
		try {
			return decryptValue(blob, versionKey, aad);
		} catch {
			return undefined;
		}
	};

	/**
	 * Attempt to decrypt an entry. Returns a plaintext entry on success,
	 * `undefined` on failure. When a key IS active and decryption still fails,
	 * logs a single warning with the entry key and actionable failure reason.
	 */
	const tryDecryptEntry = (
		key: string,
		entry: YKeyValueLwwEntry<EncryptedBlob | T>,
	): YKeyValueLwwEntry<T> | undefined => {
		if (!isEncryptedBlob(entry.val)) return { ...entry, val: entry.val as T }; // Plaintext — nothing to decrypt
		const json = tryDecryptBlob(entry.val, textEncoder.encode(key));
		if (json !== undefined) return { ...entry, val: JSON.parse(json) as T };
		if (!encryption) return undefined; // No key loaded yet — skip silently, activateEncryption() will catch up

		const blobVersion = getKeyVersion(entry.val);
		const isKnownKeyVersion = encryption.keyring.has(blobVersion);
		const reason = isKnownKeyVersion
			? 'wrong key material or corrupted blob'
			: `keyVersion=${blobVersion} not in keyring [${[...encryption.keyring.keys()].join(', ')}]`;
		console.warn(`[encrypted-kv] Failed to decrypt entry "${key}": ${reason}`);
		return undefined;
	};

	/** Silent decrypt—returns plaintext value or `undefined`. No console warning. */
	const tryDecryptValue = (
		raw: EncryptedBlob | T,
		aad: Uint8Array,
		state: EncryptionState | undefined = encryption,
	): T | undefined => {
		if (!isEncryptedBlob(raw)) return raw as T;
		const json = tryDecryptBlob(raw, aad, state);
		if (!json) return undefined;
		return JSON.parse(json) as T;
	};

	/** Count entries that can be decrypted (or are plaintext) with the current keyring. */
	const countDecryptable = (): number => {
		let count = 0;
		for (const [key, entry] of inner.map)
			if (tryDecryptValue(entry.val, textEncoder.encode(key)) !== undefined)
				count++;
		return count;
	};

	/** Iterate entries, decrypting each on the fly. Undecryptable entries are skipped. */
	const iterateDecrypted = function* (
		iterable: Iterable<[string, YKeyValueLwwEntry<EncryptedBlob | T>]>,
	): IterableIterator<[string, YKeyValueLwwEntry<T>]> {
		for (const [key, entry] of iterable) {
			const val = tryDecryptValue(entry.val, textEncoder.encode(key));
			if (val !== undefined) yield [key, { ...entry, val }];
		}
	};

	/**
	 * Inner observer. When entries change in the CRDT, decrypt and forward
	 * plaintext change events to registered handlers. Skips REENCRYPT_ORIGIN writes
	 * (those are internal re-encryption during activation, not user changes).
	 */
	const observer: Parameters<typeof inner.observe>[0] = (changes, origin) => {
		if (origin === REENCRYPT_ORIGIN) return;
		const decryptedChanges = new Map<string, KvStoreChange<T>>();
		for (const [key, change] of changes) {
			if (change.action === 'delete') {
				decryptedChanges.set(key, { action: 'delete' });
				continue;
			}
			const entry = inner.map.get(key);
			if (!entry) continue;
			const decrypted = tryDecryptEntry(key, entry);
			if (!decrypted) continue;
			decryptedChanges.set(key, {
				action: change.action,
				newValue: decrypted.val,
			});
		}
		if (decryptedChanges.size === 0) return;
		for (const handler of changeHandlers)
			handler(decryptedChanges, origin);
	};

	inner.observe(observer);

	return {
		set(key, val) {
			if (!encryption) {
				inner.set(key, val);
				return;
			}
			inner.set(
				key,
				encryptValue(
					JSON.stringify(val),
					encryption.currentKey,
					textEncoder.encode(key),
					encryption.currentVersion,
				),
			);
		},
		bulkSet(entries) {
			if (!encryption) {
				inner.bulkSet(entries);
				return;
			}
			const enc = encryption;

			inner.bulkSet(
				entries.map(({ key, val }) => ({
					key,
					val: encryptValue(
						JSON.stringify(val),
						enc.currentKey,
						textEncoder.encode(key),
						enc.currentVersion,
					),
				})),
			);
		},
		/**
		 * Get a decrypted value by key. Reads from the inner store and decrypts
		 * on the fly (~0.01ms for XChaCha20-Poly1305 on a small JSON blob).
		 */
		get(key) {
			const raw = inner.get(key);
			if (raw === undefined) return undefined;
			return tryDecryptValue(raw, textEncoder.encode(key));
		},
		has(key) {
			const raw = inner.get(key);
			if (raw === undefined) return false;
			return tryDecryptValue(raw, textEncoder.encode(key)) !== undefined;
		},
		delete(key) {
			inner.delete(key);
		},
		bulkDelete(keys) {
			inner.bulkDelete(keys);
		},
		*entries() {
			yield* iterateDecrypted(inner.entries());
		},
		observe(handler) {
			changeHandlers.add(handler);
		},
		unobserve(handler) {
			changeHandlers.delete(handler);
		},
		activateEncryption(keyring) {
			if (keyring.size === 0)
				throw new Error('Keyring must contain at least one key');
			const previousEncryption = encryption;
			const nextVersion = Math.max(...keyring.keys());
			const nextKey = keyring.get(nextVersion);
			if (!nextKey) throw new Error(`Missing key for version ${nextVersion}`);
			const nextEncryption: EncryptionState = {
				keyring,
				currentKey: nextKey,
				currentVersion: nextVersion,
			};
			encryption = nextEncryption;

			// Walk every entry and converge it to the current key version. Three
			// cases, handled in priority order:
			//   1. Ciphertext already at currentVersion → no-op (cheap skip).
			//   2. Ciphertext at a non-current version that IS in the keyring →
			//      decrypt + re-encrypt with currentKey. This is how rotation
			//      upgrades at-rest data.
			//   3. Plaintext entries → encrypt with currentKey.
			// Ciphertext whose key version is not in the keyring is skipped
			// (unreadable; left as-is for a future applyKeys that includes it).
			//
			// A readable-with-nextEncryption entry that was NOT readable with
			// previousEncryption is emitted as a synthetic `add` event after the
			// walk — observers catch up on entries that were silently skipped
			// while the keyring didn't have their version.
			const newlyReadable = new Map<string, T>();
			const entriesToReencrypt: Array<{ key: string; val: T }> = [];
			for (const [key, entry] of inner.map) {
				const aad = textEncoder.encode(key);
				if (isEncryptedBlob(entry.val)) {
					if (getKeyVersion(entry.val) === nextEncryption.currentVersion)
						continue;
					const decrypted = tryDecryptValue(entry.val, aad, nextEncryption);
					if (decrypted === undefined) continue;
					entriesToReencrypt.push({ key, val: decrypted });
					const wasReadable = tryDecryptValue(entry.val, aad, previousEncryption);
					if (wasReadable === undefined) newlyReadable.set(key, decrypted);
				} else {
					entriesToReencrypt.push({ key, val: entry.val as T });
				}
			}

			// One transaction for the whole pass. Filtered by observers via
			// REENCRYPT_ORIGIN — downstream consumers don't see re-encryption
			// as a change (the decrypted value didn't change).
			if (entriesToReencrypt.length > 0) {
				inner.doc.transact(() => {
					for (const { key: entryKey, val } of entriesToReencrypt)
						inner.set(
							entryKey,
							encryptValue(
								JSON.stringify(val),
								nextEncryption.currentKey,
								textEncoder.encode(entryKey),
								nextEncryption.currentVersion,
							),
						);
				}, REENCRYPT_ORIGIN);
			}

			if (newlyReadable.size === 0) return;
			const syntheticChanges = new Map<string, KvStoreChange<T>>();
			for (const [key, val] of newlyReadable)
				syntheticChanges.set(key, { action: 'add', newValue: val });
			for (const handler of changeHandlers)
				handler(syntheticChanges, undefined);
		},
		get unreadableEntryCount() {
			return inner.map.size - countDecryptable();
		},
		get size() {
			return countDecryptable();
		},
		yarray: inner.yarray,
		doc: inner.doc,
		dispose() {
			inner.unobserve(observer);
			inner.dispose();
		},
	};
}
