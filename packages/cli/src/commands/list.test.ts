/**
 * Unit coverage for the pure helpers in `list.ts`. Renderer text output
 * and CLI argv plumbing are exercised end-to-end via the route tests in
 * `daemon/list-route.test.ts` and the command tests under `test/`; here
 * we lock the small data projection that the renderer reuses.
 */

import { describe, expect, test } from 'bun:test';

import { filterByPath } from './list';

describe('filterByPath', () => {
	const entries = {
		'demo.actions.counter.get': { type: 'query' as const },
		'demo.actions.counter.set': { type: 'mutation' as const },
		'other.thing': { type: 'query' as const },
	};

	test('empty path returns the input unchanged', () => {
		expect(filterByPath(entries, '')).toBe(entries);
	});

	test('exact-leaf path returns just that leaf', () => {
		expect(
			Object.keys(filterByPath(entries, 'demo.actions.counter.get')),
		).toEqual(['demo.actions.counter.get']);
	});

	test('subtree prefix returns descendants', () => {
		expect(
			Object.keys(filterByPath(entries, 'demo.actions.counter')).sort(),
		).toEqual(['demo.actions.counter.get', 'demo.actions.counter.set']);
	});

	test('non-matching prefix returns empty', () => {
		expect(filterByPath(entries, 'nope')).toEqual({});
	});
});
