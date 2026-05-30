/**
 * Format Output Tests
 *
 * Exercises the public `output` function: JSON for single values, JSONL for
 * arrays, pretty-on-TTY / compact-on-pipe. Captures stdout via console.log.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { fail, output } from './format-output.js';

function captureStdout(fn: () => void): string {
	const original = console.log;
	const lines: string[] = [];
	console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
	try {
		fn();
	} finally {
		console.log = original;
	}
	return lines.join('\n');
}

function withTTY<T>(isTTY: boolean, fn: () => T): T {
	const original = process.stdout.isTTY;
	Object.defineProperty(process.stdout, 'isTTY', {
		value: isTTY,
		writable: true,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: original,
			writable: true,
			configurable: true,
		});
	}
}

describe('output (json)', () => {
	test('pretty-prints when TTY', () => {
		const result = withTTY(true, () =>
			captureStdout(() => output({ name: 'test', value: 42 })),
		);
		expect(result).toBe('{\n  "name": "test",\n  "value": 42\n}');
	});

	test('compacts when not TTY', () => {
		const result = withTTY(false, () =>
			captureStdout(() => output({ name: 'test', value: 42 })),
		);
		expect(result).toBe('{"name":"test","value":42}');
	});

	test('compacts when format is jsonl regardless of TTY', () => {
		const result = withTTY(true, () =>
			captureStdout(() => output([{ name: 'test' }], { format: 'jsonl' })),
		);
		expect(result).toBe('{"name":"test"}');
	});
});

describe('output (jsonl)', () => {
	test('outputs one object per line', () => {
		const values = [
			{ id: 1, name: 'first' },
			{ id: 2, name: 'second' },
			{ id: 3, name: 'third' },
		];
		const result = captureStdout(() => output(values, { format: 'jsonl' }));
		expect(result).toBe(
			'{"id":1,"name":"first"}\n{"id":2,"name":"second"}\n{"id":3,"name":"third"}',
		);
	});

	test('handles empty array', () => {
		const result = captureStdout(() => output([], { format: 'jsonl' }));
		expect(result).toBe('');
	});

	test('serializes mixed JSON-compatible values as one JSON value per line', () => {
		const values = [{ a: 1 }, 'string', 42, null, [1, 2, 3]];
		const result = captureStdout(() => output(values, { format: 'jsonl' }));
		expect(result).toBe('{"a":1}\n"string"\n42\nnull\n[1,2,3]');
	});

	test('wraps a non-array value as a single jsonl line', () => {
		const result = captureStdout(() =>
			output({ notAnArray: true }, { format: 'jsonl' }),
		);
		expect(result).toBe('{"notAnArray":true}');
	});
});

describe('fail', () => {
	function captureStderr(fn: () => void): string[] {
		const original = console.error;
		const lines: string[] = [];
		console.error = (...args: unknown[]) =>
			lines.push(args.map(String).join(' '));
		try {
			fn();
		} finally {
			console.error = original;
		}
		return lines;
	}

	afterEach(() => {
		process.exitCode = 0;
	});

	test('prefixes the message, prints details verbatim, and sets the exit code', () => {
		const lines = captureStderr(() =>
			fail('no peer matches "x"', { code: 3, details: ['  reason: offline'] }),
		);
		expect(lines).toEqual(['error: no peer matches "x"', '  reason: offline']);
		expect(process.exitCode).toBe(3);
	});

	test('defaults to exit code 1 with no details', () => {
		const lines = captureStderr(() => fail('boom'));
		expect(lines).toEqual(['error: boom']);
		expect(process.exitCode).toBe(1);
	});
});
