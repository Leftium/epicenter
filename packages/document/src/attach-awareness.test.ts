import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { Awareness as YAwareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { attachAwareness, createAwareness } from './attach-awareness.js';

const awarenessDefs = {
	cursorX: type('number'),
	cursorY: type('number'),
	name: type('string'),
};

function setup() {
	const ydoc = new Y.Doc({ guid: 'awareness-test' });
	const raw = new YAwareness(ydoc);
	const awareness = createAwareness(raw, awarenessDefs);
	return { ydoc, raw, awareness };
}

describe('createAwareness', () => {
	test('setLocal() and getLocal() round-trip', () => {
		const { awareness } = setup();
		awareness.setLocal({ cursorX: 10, cursorY: 20, name: 'alice' });

		expect(awareness.getLocal()).toEqual({
			cursorX: 10,
			cursorY: 20,
			name: 'alice',
		});
	});

	test('setLocalField() updates single field', () => {
		const { awareness } = setup();
		awareness.setLocal({ name: 'alice' });
		awareness.setLocalField('cursorX', 1);

		expect(awareness.getLocal()).toEqual({
			name: 'alice',
			cursorX: 1,
		});
	});

	test('getLocalField() returns undefined when not set', () => {
		const { awareness } = setup();
		expect(awareness.getLocalField('cursorX')).toBeUndefined();
	});

	test('getAll() validates fields against schema', () => {
		const { awareness, raw } = setup();
		awareness.setLocal({ cursorX: 1 });
		raw.getStates().set(202, { cursorX: 'bad', name: 'remote' });

		const all = awareness.getAll();
		expect(all.get(202)).toEqual({ name: 'remote' });
	});

	test('getAll() skips clients with zero valid fields', () => {
		const { awareness, raw } = setup();
		raw.getStates().set(333, { cursorX: 'bad' });

		expect(awareness.getAll().has(333)).toBe(false);
	});

	test('getAll() includes clients with partial valid fields', () => {
		const { awareness, raw } = setup();
		raw.getStates().set(444, { cursorX: 'bad', name: 'valid' });

		expect(awareness.getAll().get(444)).toEqual({ name: 'valid' });
	});

	test('getAll() includes self', () => {
		const { awareness, raw } = setup();
		awareness.setLocal({ name: 'me' });

		expect(awareness.getAll().get(raw.clientID)).toEqual({ name: 'me' });
	});

	describe('peers()', () => {
		test('excludes self', () => {
			const { awareness, raw } = setup();
			awareness.setLocal({ name: 'self' });

			expect(awareness.peers().has(raw.clientID)).toBe(false);
		});

		test('includes remote peers with valid fields', () => {
			const { awareness, raw } = setup();
			raw.getStates().set(101, { name: 'remote', cursorX: 3, cursorY: 4 });

			expect(awareness.peers().get(101)).toEqual({
				name: 'remote',
				cursorX: 3,
				cursorY: 4,
			});
		});

		test('includes remote peers with zero valid fields (bare clients)', () => {
			const { awareness, raw } = setup();
			raw.getStates().set(102, { bogus: true });

			expect(awareness.peers().get(102)).toEqual({});
		});

		test('validates fields against schema (rejects invalid)', () => {
			const { awareness, raw } = setup();
			raw.getStates().set(103, { name: 123, cursorX: 'bad' });

			expect(awareness.peers().get(103)).toEqual({});
		});

		test('returns empty map when no remote peers', () => {
			const { awareness } = setup();
			expect(awareness.peers().size).toBe(0);
		});
	});

	test('observe() fires on awareness changes', () => {
		const { awareness } = setup();
		let calls = 0;

		const unobserve = awareness.observe(() => {
			calls++;
		});

		awareness.setLocal({ name: 'alice' });
		expect(calls).toBe(1);

		unobserve();
	});

	test('observe() returns unsubscribe function', () => {
		const { awareness } = setup();
		let calls = 0;

		const unobserve = awareness.observe(() => {
			calls++;
		});

		unobserve();
		awareness.setLocal({ name: 'alice' });

		expect(calls).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// attachAwareness (full entry point used by createDocuments)
// ════════════════════════════════════════════════════════════════════════════

describe('attachAwareness', () => {
	test('constructs a fresh y-protocols Awareness bound to the ydoc', () => {
		const ydoc = new Y.Doc();
		const { raw } = attachAwareness(ydoc, { name: type('string') });

		expect(raw).toBeInstanceOf(YAwareness);
		expect(raw.doc).toBe(ydoc);
	});

	test('empty defs — works as a structural slot for extension wiring', () => {
		// createDocuments uses `attachAwareness(contentYdoc, {}).raw` when a
		// per-row content doc has no typed awareness schema but still needs an
		// Awareness instance to hand to sync extensions.
		const ydoc = new Y.Doc();
		const awareness = attachAwareness(ydoc, {});

		// `.raw` is usable regardless of defs.
		expect(awareness.raw).toBeInstanceOf(YAwareness);

		// With no defs, `getAll()` of a remote state surfaces zero valid fields.
		awareness.raw.getStates().set(777, { anything: 'goes' });
		expect(awareness.getAll().has(777)).toBe(false);
	});

	test('ydoc.destroy() tears down the Awareness via its self-registered hook', () => {
		const ydoc = new Y.Doc();
		const { raw } = attachAwareness(ydoc, {});

		let destroyed = 0;
		raw.on('destroy', () => {
			destroyed++;
		});

		ydoc.destroy();
		expect(destroyed).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// attachAwareness — reentrance guard (TDD: failing before Phase 3 lands)
// ════════════════════════════════════════════════════════════════════════════

describe('attachAwareness — reentrance guard', () => {
	test('second attach to the same Y.Doc throws with a clear message naming the awareness slot', () => {
		const ydoc = new Y.Doc({ guid: 'attach-awareness-reentrance' });
		attachAwareness(ydoc, { name: type('string') });

		expect(() => attachAwareness(ydoc, { name: type('string') })).toThrow(
			/awareness/i,
		);
	});

	test('destroy then reattach on the same Y.Doc does not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-awareness-destroy-reattach' });
		attachAwareness(ydoc, { name: type('string') });
		ydoc.destroy();

		expect(() =>
			attachAwareness(ydoc, { name: type('string') }),
		).not.toThrow();
	});

	test('separate Y.Docs do not interfere', () => {
		const docA = new Y.Doc({ guid: 'attach-awareness-doc-a' });
		const docB = new Y.Doc({ guid: 'attach-awareness-doc-b' });
		attachAwareness(docA, { name: type('string') });

		expect(() =>
			attachAwareness(docB, { name: type('string') }),
		).not.toThrow();
	});

	test('silent-data-loss scenario is loud: second attach throws BEFORE any mutation on the second wrapper', () => {
		const ydoc = new Y.Doc({ guid: 'attach-awareness-loud' });
		const first = attachAwareness(ydoc, { name: type('string') });
		first.setLocal({ name: 'alice' });

		let secondWrapperReached = false;
		expect(() => {
			const second = attachAwareness(ydoc, { name: type('string') });
			secondWrapperReached = true;
			second.setLocal({ name: 'clobbered' });
		}).toThrow(/awareness/i);

		expect(secondWrapperReached).toBe(false);
		expect(first.getLocal()).toEqual({ name: 'alice' });
	});
});
