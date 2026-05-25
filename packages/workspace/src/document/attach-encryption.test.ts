/**
 * attachEncryption tests: keyring lookup failures surface at construction,
 * and constructed table/kv handles are typed and active.
 *
 * Encrypted IndexedDB and owner-scoped BroadcastChannel behavior live on
 * `attachLocalStorage`; see `attach-local-storage.test.ts` for those
 * round-trip tests.
 */

import { describe, expect, test } from 'bun:test';
import type { Keyring } from '@epicenter/encryption';
import { bytesToBase64 } from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { attachEncryption } from './attach-encryption.js';
import { column } from './column/index.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';

function toKeyring(key: Uint8Array): Keyring {
	return [{ version: 1, keyBytesBase64: bytesToBase64(key) }];
}

const entries = defineTable({
	id: column.string(),
	title: column.string(),
});

describe('attachEncryption', () => {
	test('keyring callback throwing at construction surfaces the throw', () => {
		const ydoc = new Y.Doc({ guid: 'enc-no-keys', gc: true });
		expect(() =>
			attachEncryption(ydoc, {
				keyring: () => {
					throw new Error('not signed-in');
				},
				tables: { entries },
				kv: {},
			}),
		).toThrow('not signed-in');
	});

	test('returns typed encrypted table handles keyed by definition name', () => {
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-tables', gc: true });
		const { tables } = attachEncryption(ydoc, {
			keyring: () => keyring,
			tables: { entries },
			kv: {},
		});

		tables.entries.set({ id: '1', title: 'Secret row' });

		expect(tables.entries.get('1').data).toEqual({
			id: '1',
			title: 'Secret row',
		});
	});

	test('returns a typed encrypted KV handle backed by the same ydoc', () => {
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-kv', gc: true });
		const { kv } = attachEncryption(ydoc, {
			keyring: () => keyring,
			tables: {},
			kv: {
				theme: defineKv(Type.String(), () => 'dark'),
			},
		});

		expect(kv.get('theme')).toBe('dark');
		kv.set('theme', 'light');
		expect(kv.get('theme')).toBe('light');
	});
});
