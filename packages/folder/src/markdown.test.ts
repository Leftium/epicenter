/**
 * Markdown Row Source Tests
 *
 * Verifies mandatory frontmatter framing, schema-free parsing, and
 * source-preserving patches. Source either parses as a whole or fails as a
 * whole. A patch replaces only touched value spans; anything it cannot do
 * safely is a refusal, never a rewrite or a throw.
 *
 * Key behaviors:
 * - Both exact `---` lines are required; a BOM, LF, and CRLF are accepted
 * - An empty or comment-only block is an empty mapping
 * - Missing or unclosed fences, invalid YAML, duplicate keys, a non-mapping,
 *   a non-string key, and an unconvertible alias fail parsing, with no
 *   recovered values or body
 * - BOM, CRLF, comments, quoting, and unknown keys survive a field update
 * - A patch refusal says whether the source did not parse, a value cannot be
 *   written, or the patch would be unsafe; a body-only patch needs parsing too
 * - New source always has both fences
 *
 * See also:
 * - `table.test.ts` for field conformance and publication over this parser
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	composeSource,
	frameSource,
	parseSource,
	patchSource,
} from './markdown.js';

const BOM = '﻿';

describe('framing', () => {
	test('locates frontmatter behind a BOM with CRLF lines', () => {
		const source = `${BOM}---\r\ntitle: A\r\n---\r\nBody\r\n`;
		const frame = frameSource(source);
		expect(frame.kind).toBe('frontmatter');
		if (frame.kind !== 'frontmatter') return;
		expect(frame.bom).toBe(BOM);
		expect(frame.newline).toBe('\r\n');
		expect(source.slice(frame.yamlStart, frame.yamlEnd)).toBe('title: A\r\n');
		expect(source.slice(frame.bodyStart)).toBe('Body\r\n');
		expect(expectOk(parseSource(source))).toEqual({
			values: { title: 'A' },
			body: 'Body\r\n',
		});
	});

	test('an empty or comment-only block is an empty mapping, and the body may be empty', () => {
		for (const [source, body] of [
			['---\n---\n', ''],
			['---\n---', ''],
			['---\n# only a comment\n---\nBody\n', 'Body\n'],
			['---\r\n\r\n---\r\n', ''],
		] as const)
			expect(expectOk(parseSource(source))).toEqual({ values: {}, body });
	});

	test('source without an exact opening line fails parsing instead of reading as a body', () => {
		for (const source of [
			'',
			'Just text\n---\nmore\n',
			' ---\ntitle: A\n---\n',
			'--- \ntitle: A\n---\n',
			'----\ntitle: A\n---\n',
			`\n---\ntitle: A\n---\n`,
		]) {
			expect(frameSource(source).kind).toBe('missing');
			const error = expectErr(parseSource(source));
			expect(error.message).toContain('does not start with a --- line');
			expect(error.diagnostics.length).toBeGreaterThan(0);
		}
	});

	test('an opening line with no exact closing line fails parsing instead of guessing a body', () => {
		for (const source of [
			'---',
			'---\ntitle: A\nBody\n',
			'---\ntitle: A\n--- \nBody\n',
			'---\ntitle: A\n ---\n',
		]) {
			expect(frameSource(source).kind).toBe('unclosed');
			expect(expectErr(parseSource(source)).message).toContain('no closing');
		}
	});
});

describe('parse failures', () => {
	const failures = {
		'invalid YAML': '---\ntitle: [unclosed\n---\nbody\n',
		'a duplicate key': '---\ntitle: A\ntitle: B\n---\nbody\n',
		'a sequence': '---\n- a\n- b\n---\nbody\n',
		'a scalar': '---\njust text\n---\nbody\n',
		'a numeric key': '---\n1: one\ntitle: A\n---\nbody\n',
		'a null key': '---\n~: none\n---\nbody\n',
		'a mapping key': '---\n? {a: 1}\n: x\n---\nbody\n',
		'an unresolvable alias': '---\nx: *missing\ntitle: A\n---\nbody\n',
		'a circular alias': '---\nloop: &a [*a]\ntitle: A\n---\nbody\n',
		// Each level repeats the previous one ten times: 10^4 nodes from a few lines.
		'an alias expansion past the limit': `---\nl0: &l0 [x, x, x, x, x, x, x, x, x, x]\n${[
			1, 2, 3, 4,
		]
			.map(
				(level) =>
					`l${level}: &l${level} [${Array(10)
						.fill(`*l${level - 1}`)
						.join(', ')}]`,
			)
			.join('\n')}\ntitle: A\n---\nbody\n`,
	};

	for (const [name, source] of Object.entries(failures)) {
		test(`${name} fails parsing with diagnostics and no recovered values or body`, () => {
			const result = parseSource(source);
			expect(result.data).toBeNull();
			const error = expectErr(result);
			expect(error.message).not.toBe('');
			expect(error.diagnostics.length).toBeGreaterThan(0);
			for (const diagnostic of error.diagnostics)
				expect(diagnostic.message).not.toBe('');
		});

		test(`${name} refuses a field patch and a body-only patch as unparsed`, () => {
			for (const change of [{ fields: { title: 'B' } }, { body: 'new\n' }]) {
				const refusal = expectErr(patchSource(source, change));
				expect(refusal.kind).toBe('unparsed');
			}
		});
	}

	test('a YAML diagnostic names the source line it is on', () => {
		const error = expectErr(
			parseSource('---\ntitle: A\ndone: [unclosed\n---\nbody\n'),
		);
		expect(error.diagnostics.some((d) => d.message.startsWith('Line '))).toBe(
			true,
		);
	});

	test('a resolvable alias converts, and unknown keys are ordinary values', () => {
		expect(
			expectOk(parseSource('---\nbase: &b x\ncopy: *b\nextra: 1\n---\n'))
				.values,
		).toEqual({ base: 'x', copy: 'x', extra: 1 });
	});
});

describe('patchSource', () => {
	test('replaces only the touched value, keeping BOM, CRLF, comments, quotes, and unknown keys', () => {
		const source = [
			`${BOM}---`,
			'# a leading comment',
			"title: 'Buy milk' # keep this note",
			'done: false',
			'unknown: {nested: [1, 2]}  # unknown key',
			'quoted: "yes"',
			'---',
			'Body line one',
			'',
		].join('\r\n');
		expect(expectOk(patchSource(source, { fields: { done: true } }))).toBe(
			source.replace('done: false', 'done: true'),
		);
	});

	test('appends a missing key before the closing fence with the file newline style', () => {
		const source = '---\r\ntitle: A\r\n---\r\nBody';
		expect(expectOk(patchSource(source, { fields: { done: false } }))).toBe(
			'---\r\ntitle: A\r\ndone: false\r\n---\r\nBody',
		);
		expect(
			expectOk(patchSource('---\n---\nBody', { fields: { done: false } })),
		).toBe('---\ndone: false\n---\nBody');
	});

	test('fills an empty value with a separating space', () => {
		expect(
			expectOk(
				patchSource('---\ntitle:\ndone: false\n---\n', {
					fields: { title: 'Named' },
				}),
			),
		).toBe('---\ntitle: Named\ndone: false\n---\n');
	});

	test('quotes strings YAML would read as another type', () => {
		const patched = expectOk(
			patchSource('---\ntitle: A\n---\n', { fields: { title: 'true' } }),
		);
		expect(expectOk(parseSource(patched)).values).toEqual({ title: 'true' });
	});

	test('writes multi-line strings on one line and keeps following keys intact', () => {
		const source = '---\ntitle: |\n  one\n  two\ndone: false\n---\n';
		expect(expectOk(patchSource(source, { fields: { title: 'a\nb' } }))).toBe(
			'---\ntitle: "a\\nb"\ndone: false\n---\n',
		);
	});

	test('replaces the body without touching frontmatter bytes', () => {
		const source = '---\r\ntitle: A # c\r\n---\r\nOld body\r\n';
		expect(expectOk(patchSource(source, { body: 'New body\r\n' }))).toBe(
			'---\r\ntitle: A # c\r\n---\r\nNew body\r\n',
		);
	});

	test('fence-less source is not an instruction to insert frontmatter', () => {
		const refusal = expectErr(
			patchSource(`${BOM}Body\r\n`, { fields: { title: 'A' } }),
		);
		expect(refusal.kind).toBe('unparsed');
	});

	test('source that parses but cannot be patched safely is refused as unsafe, not unparsed', () => {
		const anchored = expectErr(
			patchSource('---\nbase: &b x\ntitle: *b\n---\n', {
				fields: { title: 'y' },
			}),
		);
		expect(anchored).toMatchObject({ kind: 'unsafe' });
		expect(
			expectErr(
				patchSource('---\n{title: A}\n---\n', { fields: { title: 'B' } }),
			).kind,
		).toBe('unsafe');
		// The same sources still take a body change: no span of YAML is touched.
		expect(
			expectOk(patchSource('---\n{title: A}\n---\nold', { body: 'new' })),
		).toBe('---\n{title: A}\n---\nnew');
	});

	test('a value that cannot be written is refused by its field, whatever the source', () => {
		for (const value of [Number.NaN, undefined, () => {}, { a: undefined }])
			expect(
				expectErr(
					patchSource('---\ntitle: A\n---\n', { fields: { title: value } }),
				),
			).toMatchObject({ kind: 'value', field: 'title' });
	});
});

describe('composeSource', () => {
	test('writes the supplied order and reads back', () => {
		const source = expectOk(
			composeSource({ title: 'Walk: the dog', done: false }, 'Notes\n'),
		);
		expect(source).toBe(
			'---\ntitle: "Walk: the dog"\ndone: false\n---\nNotes\n',
		);
		expect(expectOk(parseSource(source))).toEqual({
			values: { title: 'Walk: the dog', done: false },
			body: 'Notes\n',
		});
	});

	test('always writes both fences, with no fields and with no body', () => {
		expect(expectOk(composeSource({}, ''))).toBe('---\n---\n');
		expect(expectOk(composeSource({}, 'Body\r\n'))).toBe(
			'---\r\n---\r\nBody\r\n',
		);
		expect(expectOk(parseSource(expectOk(composeSource({}, ''))))).toEqual({
			values: {},
			body: '',
		});
	});

	test('refuses a value that cannot be written, naming its field', () => {
		expect(
			expectErr(
				composeSource({ title: 'A', count: Number.POSITIVE_INFINITY }, ''),
			),
		).toMatchObject({ kind: 'value', field: 'count' });
	});
});
