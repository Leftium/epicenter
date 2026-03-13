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

type EncryptedKvLwwOptions = { getKey?: () => Uint8Array | undefined };

export type EncryptedKvLww<T> = {
	set(key: string, val: T): void;
	get(key: string): T | undefined;
	has(key: string): boolean;
	delete(key: string): void;
	entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]>;
	observe(handler: YKeyValueLwwChangeHandler<T>): void;
	unobserve(handler: YKeyValueLwwChangeHandler<T>): void;
	readonly map: Map<string, YKeyValueLwwEntry<T>>;
	readonly yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>;
	readonly doc: Y.Doc;
};

/**
 * Compose transparent encryption onto `YKeyValueLww` without forking CRDT logic.
 * `YKeyValueLww` remains the single source for conflict resolution; this wrapper only
 * transforms values at the boundary (`set` encrypts, observer/get decrypts).
 * `getKey` is a getter so delayed key availability and key rotation work without recreation.
 * @example
 * ```typescript
 * const kv = createEncryptedKvLww<string>(yarray, { getKey: () => workspaceKey });
 * kv.set('title', 'Encrypted note');
 * kv.get('title'); // 'Encrypted note'
 * ```
 */
export function createEncryptedKvLww<T>(
	yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>,
	options?: EncryptedKvLwwOptions,
): EncryptedKvLww<T> {
	const inner = new YKeyValueLww<EncryptedBlob | T>(yarray);
	const map = new Map<string, YKeyValueLwwEntry<T>>();
	const pending = new Map<string, YKeyValueLwwEntry<T>>();
	const pendingDeletes = new Set<string>();
	const changeHandlers = new Set<YKeyValueLwwChangeHandler<T>>();
	const getKey = options?.getKey ?? (() => undefined);

	const maybeDecrypt = (value: EncryptedBlob | T): T => {
		const key = getKey();
		if (!key || !isEncryptedBlob(value)) return value as T;
		return JSON.parse(decryptValue(value, key)) as T;
	};

	for (const [key, entry] of inner.map)
		map.set(key, { ...entry, val: maybeDecrypt(entry.val) });

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
