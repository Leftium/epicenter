/**
 * attachEncryptedKv reentrance tests.
 *
 * `attachEncryptedKv` is a singleton slot per Y.Doc (backed by the reserved
 * `KV_KEY` Y.Array). A second attach to the same Y.Doc must throw with a clear
 * message naming the KV slot — a phantom second wrapper over the same Y.Array
 * is a silent data-loss bug.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachEncryption } from '../shared/attach-encryption.js';
import { attachEncryptedKv } from './attach-kv.js';
import { defineKv } from './define-kv.js';

function makeDefs() {
	return {
		theme: defineKv(type({ mode: "'light' | 'dark'" }), {
			mode: 'light' as const,
		}),
	};
}

describe('attachEncryptedKv — reentrance guard', () => {
	test('second attach to the same Y.Doc throws with a clear message naming the KV slot', () => {
		const ydoc = new Y.Doc({ guid: 'attach-kv-reentrance' });
		const enc = attachEncryption(ydoc);
		attachEncryptedKv(ydoc, enc, makeDefs());

		expect(() => attachEncryptedKv(ydoc, enc, makeDefs())).toThrow(/kv/i);
	});

	test('destroy then reattach on the same Y.Doc does not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-kv-destroy-reattach' });
		const enc = attachEncryption(ydoc);
		attachEncryptedKv(ydoc, enc, makeDefs());
		ydoc.destroy();

		const ydoc2 = new Y.Doc({ guid: 'attach-kv-destroy-reattach-2' });
		const enc2 = attachEncryption(ydoc2);
		expect(() => attachEncryptedKv(ydoc2, enc2, makeDefs())).not.toThrow();
	});

	test('separate Y.Docs do not interfere', () => {
		const docA = new Y.Doc({ guid: 'attach-kv-doc-a' });
		const docB = new Y.Doc({ guid: 'attach-kv-doc-b' });
		const encA = attachEncryption(docA);
		const encB = attachEncryption(docB);
		attachEncryptedKv(docA, encA, makeDefs());

		expect(() => attachEncryptedKv(docB, encB, makeDefs())).not.toThrow();
	});

	test('silent-data-loss scenario is loud: second attach throws BEFORE any mutation on the second wrapper', () => {
		const ydoc = new Y.Doc({ guid: 'attach-kv-loud' });
		const enc = attachEncryption(ydoc);
		const first = attachEncryptedKv(ydoc, enc, makeDefs());
		first.set('theme', { mode: 'dark' });

		let secondWrapperReached = false;
		expect(() => {
			const second = attachEncryptedKv(ydoc, enc, makeDefs());
			secondWrapperReached = true;
			second.set('theme', { mode: 'light' });
		}).toThrow(/kv/i);

		expect(secondWrapperReached).toBe(false);
		expect(first.get('theme')).toEqual({ mode: 'dark' });
	});
});
