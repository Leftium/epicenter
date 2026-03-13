import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	type EncryptedBlob,
	generateEncryptionKey,
	isEncryptedBlob,
} from '../crypto';
import type { YKeyValueLwwEntry } from './y-keyvalue-lww';
import { createEncryptedKvLww } from './y-keyvalue-lww-encrypted';

type PlainChange<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; oldValue: T; newValue: T }
	| { action: 'delete'; oldValue: T };

function syncDocs(from: Y.Doc, to: Y.Doc): void {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
}

function syncBoth(doc1: Y.Doc, doc2: Y.Doc): void {
	syncDocs(doc1, doc2);
	syncDocs(doc2, doc1);
}

function createEncryptedBlob<T>(value: T, key: Uint8Array): EncryptedBlob {
	const helperDoc = new Y.Doc({ guid: 'helper-blob' });
	const helperArray =
		helperDoc.getArray<YKeyValueLwwEntry<EncryptedBlob | T>>('helper-data');
	const helperKv = createEncryptedKvLww<T>(helperArray, { getKey: () => key });

	helperKv.set('helper-key', value);

	const entry = helperArray.toArray()[0];
	if (!entry || !isEncryptedBlob(entry.val)) {
		throw new Error('Expected helper entry to be encrypted');
	}

	return entry.val;
}

describe('createEncryptedKvLww', () => {
	describe('Basic encrypted operations', () => {
		test('set() encrypts, get() decrypts round-trip', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('secret', 'hello-world');

			expect(kv.get('secret')).toBe('hello-world');
		});

		test('values in Y.Array are encrypted', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('secret', 'cipher-me');

			const [entry] = yarray.toArray();
			expect(entry).toBeDefined();
			expect(isEncryptedBlob(entry?.val)).toBe(true);
		});

		test('complex object round-trip', () => {
			type Bookmark = { url: string; title: string };
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | Bookmark>>('data');
			const kv = createEncryptedKvLww<Bookmark>(yarray, { getKey: () => key });

			const value: Bookmark = { url: 'https://bank.com', title: 'My Bank' };
			kv.set('site', value);

			expect(kv.get('site')).toEqual(value);
		});

		test('delete works', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('k', 'v');
			kv.delete('k');

			expect(kv.get('k')).toBeUndefined();
		});

		test('has works', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('k', 'v');
			expect(kv.has('k')).toBe(true);

			kv.delete('k');
			expect(kv.has('k')).toBe(false);
		});

		test('entries returns decrypted values', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('a', '1');
			kv.set('b', '2');
			kv.set('c', '3');

			const values = new Map<string, string>();
			for (const [entryKey, entry] of kv.entries())
				values.set(entryKey, entry.val);

			expect(values.get('a')).toBe('1');
			expect(values.get('b')).toBe('2');
			expect(values.get('c')).toBe('3');
		});
	});

	describe('No-key passthrough', () => {
		test('when getKey returns undefined, set/get work as plaintext', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, {
				getKey: () => undefined,
			});

			kv.set('plain', 'text');

			expect(kv.get('plain')).toBe('text');
		});

		test('when getKey returns undefined, yarray contains plaintext', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, {
				getKey: () => undefined,
			});

			kv.set('plain', 'raw-value');

			const [entry] = yarray.toArray();
			expect(entry?.val).toBe('raw-value');
			expect(isEncryptedBlob(entry?.val)).toBe(false);
		});

		test('zero overhead: wrapper.map mirrors inner behavior', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, {
				getKey: () => undefined,
			});

			kv.set('x', '10');
			kv.set('y', '20');

			expect(kv.map.get('x')?.val).toBe('10');
			expect(kv.map.get('y')?.val).toBe('20');
			expect(kv.map.size).toBe(2);
		});
	});

	describe('Observer decryption', () => {
		test('observer receives decrypted values on add', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			kv.set('foo', 'bar');

			expect(events).toEqual([
				{ key: 'foo', change: { action: 'add', newValue: 'bar' } },
			]);
		});

		test('observer receives decrypted values on update', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('foo', 'first');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			kv.set('foo', 'second');

			expect(events).toEqual([
				{
					key: 'foo',
					change: {
						action: 'update',
						oldValue: 'first',
						newValue: 'second',
					},
				},
			]);
		});

		test('observer receives correct action on delete', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('foo', 'value');

			const events: Array<{ key: string; change: PlainChange<string> }> = [];
			kv.observe((changes) => {
				for (const [entryKey, change] of changes)
					events.push({ key: entryKey, change });
			});

			kv.delete('foo');

			expect(events).toEqual([
				{ key: 'foo', change: { action: 'delete', oldValue: 'value' } },
			]);
		});

		test('unobserve stops notifications', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			let count = 0;
			const handler = () => {
				count++;
			};

			kv.observe(handler);
			kv.set('a', '1');
			kv.unobserve(handler);
			kv.set('b', '2');

			expect(count).toBe(1);
		});
	});

	describe('Mixed plaintext/encrypted (migration)', () => {
		test('reads plaintext entries as-is when key exists', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			yarray.push([{ key: 'legacy', val: 'legacy-plaintext', ts: 1000 }]);

			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });
			expect(kv.get('legacy')).toBe('legacy-plaintext');
		});

		test('reads encrypted entries correctly', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const encrypted = createEncryptedBlob('encrypted-value', key);
			yarray.push([{ key: 'enc', val: encrypted, ts: 1000 }]);

			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });
			expect(kv.get('enc')).toBe('encrypted-value');
		});

		test('mixed entries: some plaintext, some encrypted', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const encrypted = createEncryptedBlob('new-secret', key);
			yarray.push([
				{ key: 'old', val: 'old-plaintext', ts: 1000 },
				{ key: 'new', val: encrypted, ts: 1001 },
			]);

			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			expect(kv.get('old')).toBe('old-plaintext');
			expect(kv.get('new')).toBe('new-secret');
		});
	});

	describe('wrapper.map always plaintext', () => {
		test('wrapper.map contains decrypted values after set', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			kv.set('k', 'plain-view');

			expect(kv.map.get('k')?.val).toBe('plain-view');
			expect(isEncryptedBlob(yarray.toArray()[0]?.val)).toBe(true);
		});

		test('wrapper.map updated by observer on remote sync', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const kv1 = createEncryptedKvLww<string>(yarray1, { getKey: () => key });
			const kv2 = createEncryptedKvLww<string>(yarray2, { getKey: () => key });

			kv1.set('shared-key', 'from-doc1');
			syncDocs(doc1, doc2);

			expect(kv2.map.get('shared-key')?.val).toBe('from-doc1');
			expect(kv2.get('shared-key')).toBe('from-doc1');
		});
	});

	describe('Two-device sync with same key', () => {
		test('encrypted value syncs and decrypts correctly', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const kv1 = createEncryptedKvLww<string>(yarray1, { getKey: () => key });
			const kv2 = createEncryptedKvLww<string>(yarray2, { getKey: () => key });

			kv1.set('token', 'abc-123');
			syncDocs(doc1, doc2);

			expect(kv2.get('token')).toBe('abc-123');
			expect(isEncryptedBlob(yarray2.toArray()[0]?.val)).toBe(true);
		});

		test('LWW conflict resolution works through encryption', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			yarray1.push([
				{
					key: 'x',
					val: createEncryptedBlob('from-client-1-earlier', key),
					ts: 1000,
				},
			]);
			yarray2.push([
				{
					key: 'x',
					val: createEncryptedBlob('from-client-2-later', key),
					ts: 2000,
				},
			]);

			syncBoth(doc1, doc2);

			const kv1 = createEncryptedKvLww<string>(yarray1, { getKey: () => key });
			const kv2 = createEncryptedKvLww<string>(yarray2, { getKey: () => key });

			expect(kv1.get('x')).toBe('from-client-2-later');
			expect(kv2.get('x')).toBe('from-client-2-later');
		});

		test('both docs converge to same decrypted value', () => {
			const key = generateEncryptionKey();

			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const yarray1 =
				doc1.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const yarray2 =
				doc2.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');

			const kv1 = createEncryptedKvLww<string>(yarray1, { getKey: () => key });
			const kv2 = createEncryptedKvLww<string>(yarray2, { getKey: () => key });

			kv1.set('shared', 'value-from-doc1');
			kv2.set('shared', 'value-from-doc2');

			syncBoth(doc1, doc2);

			expect(kv1.get('shared')).toBe(kv2.get('shared'));
		});
	});

	describe('Key becomes available mid-session', () => {
		test('passthrough then encrypted: existing plaintext entries still readable', () => {
			let currentKey: Uint8Array | undefined;
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, {
				getKey: () => currentKey,
			});

			kv.set('old-1', 'legacy-a');
			kv.set('old-2', 'legacy-b');

			currentKey = generateEncryptionKey();
			kv.set('new-1', 'encrypted-c');

			expect(kv.get('old-1')).toBe('legacy-a');
			expect(kv.get('old-2')).toBe('legacy-b');
			expect(kv.get('new-1')).toBe('encrypted-c');

			const entries = yarray.toArray();
			const old1 = entries.find((entry) => entry.key === 'old-1');
			const old2 = entries.find((entry) => entry.key === 'old-2');
			const newer = entries.find((entry) => entry.key === 'new-1');

			expect(old1?.val).toBe('legacy-a');
			expect(old2?.val).toBe('legacy-b');
			expect(isEncryptedBlob(newer?.val)).toBe(true);
		});
	});

	describe('Batch operations', () => {
		test('set in batch is readable via get in same batch', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			let valueInBatch: string | undefined;
			ydoc.transact(() => {
				kv.set('foo', 'bar');
				valueInBatch = kv.get('foo');
			});

			expect(valueInBatch).toBe('bar');
			expect(kv.get('foo')).toBe('bar');
		});

		test('multiple sets in batch all visible via entries', () => {
			const key = generateEncryptionKey();
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray =
				ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | string>>('data');
			const kv = createEncryptedKvLww<string>(yarray, { getKey: () => key });

			const keysInBatch: string[] = [];
			ydoc.transact(() => {
				kv.set('a', '1');
				kv.set('b', '2');
				kv.set('c', '3');

				for (const [entryKey] of kv.entries()) keysInBatch.push(entryKey);
			});

			expect(keysInBatch.sort()).toEqual(['a', 'b', 'c']);
		});
	});
});
