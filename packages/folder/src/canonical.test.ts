/**
 * Canonical Row Document Tests
 *
 * Counterexamples for the codec a row editor saves through. Each test names a
 * way a canonical form could lose or invent data, and shows the codec either
 * keeps the data exactly or refuses.
 *
 * Key behaviors:
 * - Sources that differ only in YAML presentation format to identical bytes
 * - Declared keys come first in declared order; unknown keys are kept, sorted
 * - Anything without an exact JSON value is refused, never converted lossily
 * - The body is kept byte for byte; schema validation is not the codec's job
 *
 * See also:
 * - `editor.test.ts` for the editor that holds and saves these documents
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type CanonicalDocument,
	formatCanonicalDocument,
	parseCanonicalDocument,
} from './canonical.js';

/** A todos table's declared field order. */
const DECLARED = ['title', 'done', 'priority'] as const;

function parse(source: string): CanonicalDocument {
	return expectOk(parseCanonicalDocument(source));
}

function format(document: CanonicalDocument): string {
	return expectOk(formatCanonicalDocument(document, DECLARED));
}

const canonical = (source: string) => format(parse(source));

test('sources that differ only in YAML presentation format to identical bytes', () => {
	const plain = [
		'---',
		'title: Plan',
		'done: false',
		'owner: sam',
		'tags: [a, b]',
		'---',
		'Body.\n',
	].join('\n');
	const styled = [
		'﻿---',
		'# a comment that canonical form drops',
		'tags:\r\n  - \'a\'\r\n  - "b"',
		"owner: 'sam' # trailing comment",
		'"done": !!bool false',
		'title: >-\r\n  Plan',
		'---',
		'Body.\n',
	].join('\r\n');
	// The body must match too, so the styled source ends its fence with LF.
	const styledLfBody = styled.replace('---\r\nBody.\n', '---\nBody.\n');

	expect(canonical(styledLfBody)).toBe(canonical(plain));
	expect(canonical(plain)).toBe(
		[
			'---',
			'"title": "Plan"',
			'"done": false',
			'"owner": "sam"',
			'"tags": ["a", "b"]',
			'---',
			'Body.\n',
		].join('\n'),
	);
});

test('declared keys come first in declared order, then other keys in code unit order', () => {
	const text = canonical(
		[
			'---',
			'zeta: 1',
			'"10": ten',
			'priority: high',
			'"2": two',
			'Alpha: 3',
			'title: T',
			'---',
			'',
		].join('\n'),
	);
	// `done` is declared but absent, so it is not invented.
	expect(text).toBe(
		[
			'---',
			'"title": "T"',
			'"priority": "high"',
			'"10": "ten"',
			'"2": "two"',
			'"Alpha": 3',
			'"zeta": 1',
			'---',
			'',
		].join('\n'),
	);
	// Integer-like keys that JS objects reorder still format in code unit order.
	expect(Object.keys(parse(text).fields)).toEqual([
		'2',
		'10',
		'title',
		'priority',
		'Alpha',
		'zeta',
	]);
});

test('parse and format are idempotent byte for byte', () => {
	const source = [
		'---',
		'meta: {z: [3, {y: 1, x: null}], a: true}',
		'title: "Unicode é 漢字 😀 and a literal   separator"',
		'n: -0',
		'f: 1.5e-7',
		'---',
		'body',
	].join('\n');
	const first = canonical(source);
	const second = canonical(first);
	const third = canonical(second);
	expect(second).toBe(first);
	expect(third).toBe(first);
	expect(first).toContain(' ');
	expect(parse(first).fields.title).toBe(
		'Unicode é 漢字 😀 and a literal   separator',
	);
});

test('nested unknown values are kept, with nested keys sorted', () => {
	const document = parse(
		[
			'---',
			'title: T',
			'extra:',
			'  zed: [1, two, null, false, {b: 2, a: [ ]}]',
			'  alpha: {inner: {deep: "x"}}',
			'---',
			'',
		].join('\n'),
	);
	expect(document.fields.extra).toEqual({
		zed: [1, 'two', null, false, { b: 2, a: [] }],
		alpha: { inner: { deep: 'x' } },
	});
	expect(format(document)).toBe(
		[
			'---',
			'"title": "T"',
			'"extra": {"alpha": {"inner": {"deep": "x"}}, "zed": [1, "two", null, false, {"a": [], "b": 2}]}',
			'---',
			'',
		].join('\n'),
	);
});

test.each([
	['an unsafe integer', 'n: 9007199254740993', 'outside the safe range'],
	[
		'a rounded decimal integer',
		'n: 9007199254740993.0',
		'outside the safe range',
	],
	[
		'a rounded exponent integer',
		'n: 9.007199254740993e15',
		'outside the safe range',
	],
	[
		'an integer-valued float beyond the safe range',
		'n: 1e300',
		'outside the safe range',
	],
	['a non-finite number', 'n: .inf', 'not finite'],
	['a custom tag', 'n: !foo bar', 'Unresolved tag'],
	['binary', 'n: !!binary aGVsbG8=', 'binary is not supported'],
	['a set', 'n: !!set {x: null}', 'set is not supported'],
	['a timestamp', 'n: !!timestamp 2020-01-01', 'timestamp is not supported'],
	['a nested non-string key', 'n: {1: b}', 'key is not a string'],
	['a top-level non-string key', '1: b', 'key is not a string'],
	['a cyclic alias', 'n: &x [1, *x]', 'circular'],
	['a lone surrogate', 'n: "\\ud800"', 'lone surrogate'],
	['a duplicate key', 'n: 1\nn: 2', 'not supported YAML'],
])('refuses %s', (_, yaml, reason) => {
	const source = `---\n${yaml}\n---\nbody\n`;
	const result = parseCanonicalDocument(source);
	expect(expectErr(result).reason).toContain(reason);
});

test('format refuses values that have no exact JSON form', () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const value of [
		2 ** 53,
		Number.NaN,
		10n,
		undefined,
		new Date(0),
		cyclic,
		'\ud800',
		// biome-ignore lint/suspicious/noSparseArray: a hole is the counterexample
		[1, , 3],
	]) {
		const result = formatCanonicalDocument(
			{ fields: { x: value } as never, body: '' },
			DECLARED,
		);
		expectErr(result);
	}
});

test('safe aliases expand; alias expansion is bounded', () => {
	const document = parse(
		['---', 'base: &b {x: 1, y: [a]}', 'copy: *b', '---', ''].join('\n'),
	);
	expect(document.fields.copy).toEqual({ x: 1, y: ['a'] });
	expect(format(document)).toContain('"copy": {"x": 1, "y": ["a"]}');

	const laughs = ['---', 'a: &a [x, x, x, x, x, x, x, x, x, x]'];
	for (const [name, previous] of [
		['b', 'a'],
		['c', 'b'],
		['d', 'c'],
		['e', 'd'],
	])
		laughs.push(
			`${name}: &${name} [${Array(10).fill(`*${previous}`).join(', ')}]`,
		);
	laughs.push('---', '');
	const result = parseCanonicalDocument(laughs.join('\n'));
	expect(expectErr(result).reason).toContain('too many');
});

test('a __proto__ key is an own field and never a prototype', () => {
	const source = [
		'---',
		'"__proto__": {"__proto__": {polluted: true}, constructor: 1}',
		'---',
		'',
	].join('\n');
	const document = parse(source);
	expect(Object.hasOwn(document.fields, '__proto__')).toBe(true);
	expect(Object.getPrototypeOf(document.fields)).toBe(Object.prototype);
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	const text = format(document);
	expect(text).toBe(
		[
			'---',
			'"__proto__": {"__proto__": {"polluted": true}, "constructor": 1}',
			'---',
			'',
		].join('\n'),
	);
	expect(format(parse(text))).toBe(text);
	// Inherited properties are not fields.
	const inherited = Object.create({ inherited: 1 }) as Record<string, never>;
	expectErr(formatCanonicalDocument({ fields: inherited, body: '' }, DECLARED));
});

test('-0 survives parse and format', () => {
	for (const spelling of ['-0', '-0.0', '!!int "-0"']) {
		const document = parse(`---\nn: ${spelling}\n---\n`);
		expect(Object.is(document.fields.n, -0)).toBe(true);
		const text = format(document);
		expect(text).toBe('---\n"n": -0\n---\n');
		expect(Object.is(parse(text).fields.n, -0)).toBe(true);
	}
	expect(Object.is(parse('---\nn: 0\n---\n').fields.n, 0)).toBe(true);
});

test('the body is kept exactly: CRLF, trailing spaces, and blank lines', () => {
	const body = '\r\n\r\nline one  \r\n\t\r\n\n\nline two \t\r\n\r\n';
	const source = `---\r\ntitle: T\r\n---\r\n${body}`;
	const document = parse(source);
	expect(document.body).toBe(body);
	const text = format(document);
	expect(text).toBe(`---\n"title": "T"\n---\n${body}`);
	expect(parse(text).body).toBe(body);
	// A body line that looks like a fence is still body.
	expect(parse(format({ fields: {}, body: '---\nnot: yaml\n' })).body).toBe(
		'---\nnot: yaml\n',
	);
});

test('schema-invalid values survive: validation is outside the codec', () => {
	// The table declares `done` boolean and `priority` one of low/normal/high.
	const document = parse(
		['---', "title: 'A'", 'done: A', 'priority: 7', '---', ''].join('\n'),
	);
	expect(document.fields).toEqual({ title: 'A', done: 'A', priority: 7 });
	expect(format(document)).toBe(
		['---', '"title": "A"', '"done": "A"', '"priority": 7', '---', ''].join(
			'\n',
		),
	);
});

test('a body that UTF-8 encoding would change is refused rather than rewritten', () => {
	const body = 'before\ud800after';
	expect(
		expectErr(parseCanonicalDocument(`---\ntitle: T\n---\n${body}`)).path,
	).toEqual(['body']);
	expect(
		expectErr(formatCanonicalDocument({ fields: {}, body }, DECLARED)).path,
	).toEqual(['body']);
});
