import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { Awareness as YAwareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { attachAwareness } from './attach-awareness.js';

const awarenessDefs = {
	cursorX: type('number'),
	cursorY: type('number'),
	name: type('string'),
};

function setup() {
	const ydoc = new Y.Doc({ guid: 'awareness-test' });
	const awareness = attachAwareness(ydoc, {
		schema: awarenessDefs,
		initial: { cursorX: 0, cursorY: 0, name: 'local' },
	});
	const raw = awareness.raw;
	return { ydoc, raw, awareness };
}

describe('AwarenessAttachment', () => {
	test('setLocal() publishes local state', () => {
		const { awareness, raw } = setup();
		awareness.setLocal({ cursorX: 10, cursorY: 20, name: 'alice' });

		expect(raw.getLocalState()).toEqual({
			cursorX: 10,
			cursorY: 20,
			name: 'alice',
		});
	});

	test('setLocal() updates one field without clearing others', () => {
		const { awareness, raw } = setup();
		awareness.setLocal({ cursorX: 0, cursorY: 0, name: 'alice' });
		awareness.setLocal({ cursorX: 1 });

		expect(raw.getLocalState()).toEqual({
			name: 'alice',
			cursorX: 1,
			cursorY: 0,
		});
	});

	describe('peers()', () => {
		test('excludes self', () => {
			const { awareness, raw } = setup();
			expect(awareness.peers().has(raw.clientID)).toBe(false);
		});

		test('includes remote peers with all fields valid', () => {
			const { awareness, raw } = setup();
			raw.getStates().set(101, { name: 'remote', cursorX: 3, cursorY: 4 });

			expect(awareness.peers().get(101)).toEqual({
				name: 'remote',
				cursorX: 3,
				cursorY: 4,
			});
		});

		test('excludes remote peers missing fields', () => {
			const { awareness, raw } = setup();
			raw.getStates().set(102, { bogus: true });

			expect(awareness.peers().has(102)).toBe(false);
		});

		test('excludes remote peers with any invalid field', () => {
			const { awareness, raw } = setup();
			raw.getStates().set(103, { name: 123, cursorX: 'bad', cursorY: 0 });

			expect(awareness.peers().has(103)).toBe(false);
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

		awareness.setLocal({ name: 'alice', cursorX: 1 });
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
		awareness.setLocal({ name: 'alice', cursorX: 1 });

		expect(calls).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// attachAwareness
// ════════════════════════════════════════════════════════════════════════════

describe('attachAwareness', () => {
	test('constructs a fresh y-protocols Awareness bound to the ydoc', () => {
		const ydoc = new Y.Doc();
		const { raw } = attachAwareness(ydoc, {
			schema: { name: type('string') },
			initial: { name: 'alice' },
		});

		expect(raw).toBeInstanceOf(YAwareness);
		expect(raw.doc).toBe(ydoc);
	});

	test('publishes initial state synchronously before returning', () => {
		const ydoc = new Y.Doc();
		const awareness = attachAwareness(ydoc, {
			schema: { name: type('string'), score: type('number') },
			initial: { name: 'alice', score: 7 },
		});

		expect(awareness.raw.getLocalState()).toEqual({ name: 'alice', score: 7 });
	});

	test('empty defs — works as a structural slot', () => {
		const ydoc = new Y.Doc();
		const awareness = attachAwareness(ydoc, { schema: {}, initial: {} });

		// `.raw` is usable regardless of defs.
		expect(awareness.raw).toBeInstanceOf(YAwareness);

		// With zero defined fields, every state vacuously validates and
		// surfaces as `{}`: no fields to project.
		awareness.raw.getStates().set(777, { anything: 'goes' });
		expect(awareness.peers().get(777)).toEqual({});
	});

	test('ydoc.destroy() tears down the Awareness via its self-registered hook', () => {
		const ydoc = new Y.Doc();
		const { raw } = attachAwareness(ydoc, { schema: {}, initial: {} });

		let destroyed = 0;
		raw.on('destroy', () => {
			destroyed++;
		});

		ydoc.destroy();
		expect(destroyed).toBe(1);
	});
});
