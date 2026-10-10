/**
 * Row Reading Tests
 *
 * `parseRow` reads text as a row the way `table.get` will: one parse of the
 * complete frontmatter, then every declared field checked. Each test names a
 * kind of text and shows what a caller gets: the complete row, or issues
 * located like compiler diagnostics.
 *
 * Key behaviors:
 * - A valid row has every field, unknown keys included, as mutable values
 * - Text with no canonical form has exactly one issue, at its line
 * - A schema failure has one issue per problem, at its key's line
 * - A missing declared field is the only issue without a line
 * - Lines count the whole text; CRLF and a byte-order mark do not shift them
 * - Formatting writes plain block YAML, quoting exactly the strings a YAML
 *   1.1 reader would read as something else, and reads back as the row
 */
import { expect, test } from 'bun:test';
import {
	defineFolder,
	defineTable,
	field,
	formatRow,
	parseRow,
	type RowIssue,
} from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				done: field.boolean(),
				tags: field.tags(),
			},
		}),
	},
});
const todos = definition.tables.todos;

const lines = (...text: string[]) => text.join('\n');

const issuesOf = (text: string): readonly RowIssue[] =>
	expectErr(parseRow(todos, text));

test('a valid row has every field, unknown keys included, and its body', () => {
	const row = expectOk(
		parseRow(
			todos,
			lines(
				'---',
				'title: Buy milk',
				'done: false',
				'tags: [home]',
				'priority: high',
				'---',
				'Two percent.\n',
			),
		),
	);
	// Unknown keys are kept at runtime; the declared type names only declared fields.
	expect<unknown>(row).toEqual({
		fields: {
			title: 'Buy milk',
			done: false,
			tags: ['home'],
			priority: 'high',
		},
		body: 'Two percent.\n',
	});
});

test('a valid row belongs to its caller: mutable and shared with no other read', () => {
	const text = lines('---', 'title: A', 'done: false', 'tags: [x]', '---', '');
	const first = expectOk(parseRow(todos, text));
	const second = expectOk(parseRow(todos, text));

	first.fields.title = 'B';
	first.fields.tags.push('y');
	first.body = 'edited';

	expect(Object.isFrozen(first.fields.tags)).toBe(false);
	expect(second).toEqual({
		fields: { title: 'A', done: false, tags: ['x'] },
		body: '',
	});
});

test('text without an opening fence has one issue on line 1', () => {
	expect(issuesOf('title: A\n')).toEqual([
		{ message: 'The source does not start with a --- line', line: 1 },
	]);
});

test('an opening fence with no closing fence has one issue on line 1', () => {
	expect(issuesOf(lines('---', 'title: A', 'done: false'))).toEqual([
		{
			message: 'The frontmatter opening line has no closing --- line',
			line: 1,
		},
	]);
});

test('malformed YAML has one issue at the line the parser points to', () => {
	const issues = issuesOf(
		lines('---', 'title: A', 'done: [false', 'tags: []', '---', ''),
	);
	expect(issues).toHaveLength(1);
	expect(issues[0]?.message).toStartWith(
		'The frontmatter is not supported YAML:',
	);
	expect(issues[0]?.field).toBeUndefined();
	expect(issues[0]?.line).toBeGreaterThanOrEqual(3);
});

test('a duplicate key is one issue at the repeated key', () => {
	const issues = issuesOf(
		lines('---', 'title: A', 'done: false', 'title: B', 'tags: []', '---', ''),
	);
	expect(issues).toHaveLength(1);
	expect(issues[0]?.line).toBe(4);
});

test('frontmatter that is not a mapping has one issue at its first line', () => {
	expect(issuesOf(lines('---', '- a', '- b', '---', ''))).toEqual([
		{ message: 'The frontmatter is not a mapping', line: 2 },
	]);
});

test('a value with no JSON form is one issue at that value, inside its field', () => {
	expect(
		issuesOf(
			lines(
				'---',
				'title: A',
				'done: false',
				'count: 9007199254740993',
				'tags: []',
				'---',
				'',
			),
		),
	).toEqual([
		{
			message: 'An integer is outside the safe range',
			line: 4,
			field: 'count',
		},
	]);
	expect(
		issuesOf(
			lines(
				'---',
				'title: A',
				'done: false',
				'tags:',
				'  - ok',
				'  - 9007199254740993',
				'---',
				'',
			),
		),
	).toEqual([
		{ message: 'An integer is outside the safe range', line: 6, field: 'tags' },
	]);
});

test('a tag YAML cannot resolve is one parser issue at its line', () => {
	const issues = issuesOf(
		lines(
			'---',
			'title: A',
			'done: false',
			'tags:',
			'  - ok',
			'  - !custom x',
			'---',
			'',
		),
	);
	expect(issues).toHaveLength(1);
	expect(issues[0]?.line).toBe(6);
	expect(issues[0]?.message).toContain('!custom');
});

test('schema failures are one issue each, at the line of their key', () => {
	const issues = issuesOf(
		lines('---', 'title: A', 'done: maybe', 'tags: [1, ok, 3]', '---', ''),
	);
	expect(issues.map(({ line, field }) => ({ line, field }))).toEqual([
		{ line: 3, field: 'done' },
		{ line: 4, field: 'tags' },
		{ line: 4, field: 'tags' },
	]);
	for (const issue of issues) expect(issue.message.length).toBeGreaterThan(0);
});

test('a missing declared field is an issue with no line', () => {
	expect(issuesOf(lines('---', 'done: false', 'tags: []', '---', ''))).toEqual([
		{ message: 'title is missing', field: 'title' },
	]);
});

test('keys the table does not declare are never issues', () => {
	expectOk(
		parseRow(
			todos,
			lines(
				'---',
				'title: A',
				'done: false',
				'tags: []',
				'extra: [1, {a: 2}]',
				'---',
				'',
			),
		),
	);
});

test('CRLF line breaks and a byte-order mark do not shift lines', () => {
	const text = lines('---', 'title: A', 'done: maybe', 'tags: []', '---', '');
	const expected = issuesOf(text);
	expect(expected[0]?.line).toBe(3);
	expect(issuesOf(text.replaceAll('\n', '\r\n'))).toEqual(expected);
	expect(issuesOf(`﻿${text}`)).toEqual(expected);
});

const refined = <TSchema extends object>(
	schema: TSchema,
	refine: (value: unknown) => boolean,
) => ({ ...schema, '~refine': [{ refine, message: 'refused' }] });

test('a field callback judges a frozen copy, never the row it returns', () => {
	let seen: unknown;
	const observing = defineFolder({
		kv: {},
		tables: {
			notes: defineTable({
				fields: {
					data: refined({ type: 'object' }, (value) => {
						seen = value;
						return true;
					}),
				},
			}),
			mutating: defineTable({
				fields: {
					data: refined({ type: 'object' }, (value) => {
						if (value !== null) (value as { answer: number }).answer = 99;
						return true;
					}),
				},
			}),
		},
	});
	const text = lines('---', 'data: {answer: 42}', '---', '');

	const row = expectOk(parseRow(observing.tables.notes, text));
	expect(seen).toEqual({ answer: 42 });
	expect(seen).not.toBe(row.fields.data);
	expect(Object.isFrozen(seen)).toBe(true);
	expect(Object.isFrozen(row.fields.data)).toBe(false);

	// The attempted write throws on the frozen copy, which is reported as an issue.
	expect(expectErr(parseRow(observing.tables.mutating, text))).toEqual([
		{
			message: 'data does not conform: schema validation threw',
			line: 2,
			field: 'data',
		},
	]);
});

test('a row formats as plain block YAML and reads back as the same row', () => {
	const row = {
		fields: {
			title: 'Buy milk',
			done: false,
			tags: ['home', 'errand'],
			notes: { owner: 'sam', score: 3.5 },
			lines: 'line one\nline two\n',
		},
		body: 'Two percent.\n',
	};
	const text = expectOk(formatRow(todos, row as never));
	expect(text).toBe(
		lines(
			'---',
			'title: Buy milk',
			'done: false',
			'tags:',
			'  - home',
			'  - errand',
			'lines: |',
			'  line one',
			'  line two',
			'notes:',
			'  owner: sam',
			'  score: 3.5',
			'---',
			'Two percent.\n',
		),
	);
	expect<unknown>(expectOk(parseRow(todos, text))).toEqual(row);
});

test('strings a YAML 1.1 reader would read as something else are quoted', () => {
	const ambiguous = {
		answer: 'yes',
		light: 'Off',
		date: '2026-10-11',
		octal: '0o17',
		sexagesimal: '1:30',
		number: '42',
		tilde: '~',
		empty: '',
		spaced: '  leading',
		colon: 'a: b',
	};
	const text = expectOk(
		formatRow(todos, {
			fields: { title: 'T', done: false, tags: [], ...ambiguous },
			body: '',
		} as never),
	);
	for (const [key, value] of Object.entries(ambiguous))
		expect(text).toContain(`${key}: ${JSON.stringify(value)}\n`);
	expect<unknown>(expectOk(parseRow(todos, text)).fields).toMatchObject(
		ambiguous,
	);
});

test('an undefined field is an absent key', () => {
	const text = expectOk(
		formatRow(todos, {
			fields: { title: 'T', done: false, tags: [], gone: undefined },
			body: '',
		} as never),
	);
	expect(text).toBe(
		lines('---', 'title: T', 'done: false', 'tags: []', '---', ''),
	);
});

test('a float is written with a decimal point, which every YAML version reads as the same number', () => {
	const text = expectOk(
		formatRow(todos, {
			fields: { title: 'T', done: false, tags: [], small: 1e-7, half: 0.5 },
			body: '',
		} as never),
	);
	// PyYAML and Ruby's Psych read a bare 1e-7 as a string.
	expect(text).toContain('small: 1.0e-7\n');
	expect(text).toContain('half: 0.5\n');
	expect<unknown>(expectOk(parseRow(todos, text)).fields).toMatchObject({
		small: 1e-7,
		half: 0.5,
	});
});
