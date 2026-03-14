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
 * ## Error Containment
 *
 * The observer wraps `maybeDecrypt` with `trySync`. A failed decrypt quarantines
 * the entry (stored in `quarantine` map) and logs a warning instead of throwing.
 * This prevents one bad blob from crashing all observation. Quarantined entries
 * are retried on `onKeyChange()` when the correct key arrives.
 *
 * ## AAD Context Binding
 *
 * When `workspaceId` and `tableName` are provided, each encrypt/decrypt call
 * includes AAD = `encode(workspaceId + ':' + tableName + ':' + entryKey)`. This
 * binds ciphertext to its exact position—a blob from `table:tabs/tab-1` cannot
 * be replayed into `table:settings/theme`.
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

type EncryptedKvLwwOptions = {
	getKey?: () => Uint8Array | undefined;
	workspaceId?: string;
	tableName?: string;
};

export type EncryptionMode = 'plaintext' | 'locked' | 'unlocked';

export type YKeyValueLwwEncrypted<T> = {
	set(key: string, val: T): void;
	get(key: string): T | undefined;
	has(key: string): boolean;
	delete(key: string): void;
	entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]>;
	observe(handler: YKeyValueLwwChangeHandler<T>): void;
	unobserve(handler: YKeyValueLwwChangeHandler<T>): void;
	onKeyChange?(key: Uint8Array | undefined): void;

	readonly mode?: EncryptionMode;
	readonly quarantine?: ReadonlyMap<
		string,
		YKeyValueLwwEntry<EncryptedBlob | T>
	>;
	readonly map: Map<string, YKeyValueLwwEntry<T>>;
	readonly yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>;
	readonly doc: Y.Doc;
};

export function createEncryptedKvLww<T>(
	yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>,
	options?: EncryptedKvLwwOptions,
): YKeyValueLwwEncrypted<T> {
	const inner = new YKeyValueLww<EncryptedBlob | T>(yarray);
	const map = new Map<string, YKeyValueLwwEntry<T>>();
	const pending = new Map<string, YKeyValueLwwEntry<T>>();
	const pendingDeletes = new Set<string>();
	const changeHandlers = new Set<YKeyValueLwwChangeHandler<T>>();
	const quarantine = new Map<string, YKeyValueLwwEntry<EncryptedBlob | T>>();

	const getKey = options?.getKey ?? (() => undefined);
	let currentKey: Uint8Array | undefined = getKey();
	let mode: EncryptionMode = currentKey ? 'unlocked' : 'plaintext';

	const computeAad = (entryKey: string): Uint8Array | undefined => {
		if (!options?.workspaceId || !options?.tableName) return undefined;
		return new TextEncoder().encode(
			options.workspaceId + ':' + options.tableName + ':' + entryKey,
		);
	};

	const maybeDecrypt = (entryKey: string, value: EncryptedBlob | T): T => {
		if (!isEncryptedBlob(value)) return value as T;
		if (!currentKey) throw new Error('Missing encryption key');
		return JSON.parse(
			decryptValue(value, currentKey, computeAad(entryKey)),
		) as T;
	};

	const areValuesEqual = (left: T, right: T): boolean => {
		if (Object.is(left, right)) return true;
		const { data: leftJson } = trySync({
			try: () => JSON.stringify(left),
			catch: () => Ok(undefined),
		});
		const { data: rightJson } = trySync({
			try: () => JSON.stringify(right),
			catch: () => Ok(undefined),
		});
		if (leftJson === undefined || rightJson === undefined) return false;
		return leftJson === rightJson;
	};

	const decryptIntoMap = (
		key: string,
		entry: YKeyValueLwwEntry<EncryptedBlob | T>,
	): YKeyValueLwwEntry<T> | undefined => {
		const { data: decryptedVal, error: decryptError } = trySync({
			try: () => maybeDecrypt(key, entry.val),
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

	for (const [key, entry] of inner.map) {
		const decryptedEntry = decryptIntoMap(key, entry);
		if (!decryptedEntry) continue;
		map.set(key, decryptedEntry);
	}

	inner.observe((changes, transaction) => {
		const decryptedChanges = new Map<string, YKeyValueLwwChange<T>>();

		for (const [key, change] of changes) {
			const previousEntry = map.get(key);

			if (change.action === 'delete') {
				map.delete(key);
				quarantine.delete(key);

				if (previousEntry) {
					decryptedChanges.set(key, {
						action: 'delete',
						oldValue: previousEntry.val,
					});
				} else {
					const { data: oldValue } = trySync({
						try: () => maybeDecrypt(key, change.oldValue),
						catch: (e) => {
							console.warn(
								`[encrypted-kv] Failed to decrypt deleted entry "${key}":`,
								e,
							);
							return Ok(undefined);
						},
					});

					if (oldValue !== undefined)
						decryptedChanges.set(key, { action: 'delete', oldValue });
				}
			} else {
				const entry = inner.map.get(key);
				if (!entry) {
					pending.delete(key);
					pendingDeletes.delete(key);
					continue;
				}

				const { data: decryptedVal, error: decryptError } = trySync({
					try: () => maybeDecrypt(key, entry.val),
					catch: (e) => {
						console.warn(`[encrypted-kv] Failed to decrypt entry "${key}":`, e);
						return Ok(undefined);
					},
				});

				if (decryptError || decryptedVal === undefined) {
					quarantine.set(key, entry);
					pending.delete(key);
					pendingDeletes.delete(key);
					continue;
				}

				quarantine.delete(key);
				map.set(key, { ...entry, val: decryptedVal });

				if (change.action === 'add') {
					decryptedChanges.set(key, { action: 'add', newValue: decryptedVal });
				} else {
					const oldValue = previousEntry?.val;
					if (oldValue === undefined) {
						const { data: decryptedOldValue } = trySync({
							try: () => maybeDecrypt(key, change.oldValue),
							catch: (e) => {
								console.warn(
									`[encrypted-kv] Failed to decrypt old value for "${key}":`,
									e,
								);
								return Ok(undefined);
							},
						});

						if (decryptedOldValue !== undefined) {
							decryptedChanges.set(key, {
								action: 'update',
								oldValue: decryptedOldValue,
								newValue: decryptedVal,
							});
						}
					} else {
						decryptedChanges.set(key, {
							action: 'update',
							oldValue,
							newValue: decryptedVal,
						});
					}
				}
			}

			pending.delete(key);
			pendingDeletes.delete(key);
		}

		for (const handler of changeHandlers)
			handler(decryptedChanges, transaction);
	});

	return {
		set(key, val) {
			if (mode === 'locked')
				throw new Error('Workspace is locked — sign in to write');

			// Poll getKey() for backward compat — key might have appeared since creation
			if (mode === 'plaintext') {
				const polledKey = getKey();
				if (polledKey) {
					currentKey = polledKey;
					mode = 'unlocked';
				}
			}

			pendingDeletes.delete(key);
			pending.set(key, { key, val, ts: Date.now() });

			if (mode === 'plaintext') {
				inner.set(key, val);
				return;
			}

			if (!currentKey)
				throw new Error('Workspace is locked — sign in to write');
			inner.set(
				key,
				encryptValue(JSON.stringify(val), currentKey, computeAad(key)),
			);
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
			quarantine.delete(key);
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
		onKeyChange(nextKey) {
			const oldMap = new Map(map);
			const oldQuarantine = new Map(quarantine);

			currentKey = nextKey;

			if (nextKey) {
				mode = 'unlocked';
			} else if (mode === 'plaintext') {
				mode = 'plaintext';
			} else {
				mode = 'locked';
			}

			map.clear();
			quarantine.clear();

			for (const [key, entry] of inner.map) {
				const decryptedEntry = decryptIntoMap(key, entry);
				if (!decryptedEntry) continue;
				map.set(key, decryptedEntry);
			}

			for (const [key, oldEntry] of oldQuarantine) {
				const currentEntry = inner.map.get(key);
				if (!currentEntry) continue;
				if (map.has(key) && !quarantine.has(key)) continue;

				const retryEntry = decryptIntoMap(key, currentEntry ?? oldEntry);
				if (!retryEntry) continue;
				map.set(key, retryEntry);
			}

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
					syntheticChanges.set(key, {
						action: 'delete',
						oldValue: oldEntry.val,
					});
					continue;
				}

				if (!oldEntry || !newEntry) continue;
				if (areValuesEqual(oldEntry.val, newEntry.val)) continue;

				syntheticChanges.set(key, {
					action: 'update',
					oldValue: oldEntry.val,
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
