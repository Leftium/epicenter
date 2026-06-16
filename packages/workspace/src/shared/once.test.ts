import { describe, expect, test } from 'bun:test';

import { once } from './once.js';

describe('once', () => {
	test('runs the wrapped fn only on the first call', () => {
		let calls = 0;
		const wrapped = once(() => {
			calls++;
		});
		wrapped();
		wrapped();
		wrapped();
		expect(calls).toBe(1);
	});

	test('returns the first result on every later call', () => {
		let n = 0;
		const wrapped = once(() => ++n);
		expect(wrapped()).toBe(1);
		expect(wrapped()).toBe(1);
		expect(n).toBe(1);
	});

	test('passes the first call args and ignores later ones', () => {
		const seen: number[] = [];
		const wrapped = once((x: number) => {
			seen.push(x);
			return x;
		});
		expect(wrapped(1)).toBe(1);
		expect(wrapped(2)).toBe(1);
		expect(seen).toEqual([1]);
	});
});
