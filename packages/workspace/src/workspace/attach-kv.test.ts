/**
 * attachKv reentrance tests (TDD — failing before Phase 3 guards land).
 *
 * `attachKv` is a singleton slot per Y.Doc (backed by the reserved `KV_KEY`
 * Y.Array). Phase 3 adds a reentrance guard that throws when a caller tries to
 * attach a second KV to the same Y.Doc.
 *
 * The "second attach throws" and "loud data-loss" tests are expected to FAIL
 * today. Separate-Y.Doc baselines should pass today and continue to pass
 * after the guard lands.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachKv } from './attach-kv.js';
import { defineKv } from './define-kv.js';

function makeDefs() {
	return {
		theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' as const }),
	};
}

describe('attachKv — reentrance guard', () => {
	test('second attach to the same Y.Doc throws with a clear message naming the KV slot', () => {
		const ydoc = new Y.Doc({ guid: 'attach-kv-reentrance' });
		attachKv(ydoc, makeDefs());

		expect(() => attachKv(ydoc, makeDefs())).toThrow(/kv/i);
	});

	test('destroy then reattach on the same Y.Doc does not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-kv-destroy-reattach' });
		attachKv(ydoc, makeDefs());
		ydoc.destroy();

		expect(() => attachKv(ydoc, makeDefs())).not.toThrow();
	});

	test('separate Y.Docs do not interfere', () => {
		const docA = new Y.Doc({ guid: 'attach-kv-doc-a' });
		const docB = new Y.Doc({ guid: 'attach-kv-doc-b' });
		attachKv(docA, makeDefs());

		expect(() => attachKv(docB, makeDefs())).not.toThrow();
	});

	test('silent-data-loss scenario is loud: second attach throws BEFORE any mutation on the second wrapper', () => {
		const ydoc = new Y.Doc({ guid: 'attach-kv-loud' });
		const first = attachKv(ydoc, makeDefs()).helper;
		first.set('theme', { mode: 'dark' });

		let secondWrapperReached = false;
		expect(() => {
			const second = attachKv(ydoc, makeDefs()).helper;
			secondWrapperReached = true;
			second.set('theme', { mode: 'light' });
		}).toThrow(/kv/i);

		expect(secondWrapperReached).toBe(false);
		expect(first.get('theme')).toEqual({ mode: 'dark' });
	});
});
