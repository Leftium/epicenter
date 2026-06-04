import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';
import { serializeEntry } from './serialize';

describe('serializeEntry', () => {
	test('an empty mapping is body only (no fence)', () => {
		expect(serializeEntry({}, '# Body\ntext')).toBe('# Body\ntext');
	});

	test('emits a fence that reparses to the same values', () => {
		const out = serializeEntry(
			{ title: 'Hello', status: 'draft', count: 3 },
			'# Body',
		);
		expect(out.startsWith('---\n')).toBe(true);
		expect(parseMarkdown(out).data).toEqual({
			frontmatter: { title: 'Hello', status: 'draft', count: 3 },
			body: '# Body',
		});
	});

	test('preserves value types: a number stays a number, a numeric string stays a string', () => {
		const out = serializeEntry({ count: 3, code: '007' }, 'body');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			count: 3,
			code: '007',
		});
	});

	test('an existing null value round-trips (never invented, never dropped)', () => {
		const out = serializeEntry({ title: null }, 'body');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({ title: null });
	});

	test('the body is written verbatim', () => {
		const body = '# Heading\n\n- a\n- b\n\ntrailing text';
		const out = serializeEntry({ title: 'x' }, body);
		expect(parseMarkdown(out).data?.body).toBe(body);
	});

	test('key order follows the object', () => {
		const out = serializeEntry({ b: 1, a: 2 }, 'body');
		expect(out.indexOf('b:')).toBeLessThan(out.indexOf('a:'));
	});
});

/**
 * The full save cycle the vault runs: parse the freshest disk bytes, apply ONE
 * edit to the frontmatter object, re-emit. Exercises the real write logic
 * without Tauri, and is where round-trip identity (by value) is the contract.
 */
describe('edit cycle (parse -> edit -> serialize -> parse)', () => {
	const setField = (raw: string, key: string, value: unknown) => {
		const { data } = parseMarkdown(raw);
		if (!data) return raw;
		const frontmatter = { ...data.frontmatter };
		if (value === undefined) delete frontmatter[key];
		else frontmatter[key] = value;
		return serializeEntry(frontmatter, data.body);
	};
	const setBody = (raw: string, body: string) => {
		const { data } = parseMarkdown(raw);
		if (!data) return raw;
		return serializeEntry(data.frontmatter, body);
	};

	test('round-trip identity by VALUE: a no-op cycle preserves every value and the body', () => {
		const raw = '---\ntitle: My Post\nstatus: draft\ntags:\n  - a\n  - b\n---\n# Body\n\ntext';
		const before = parseMarkdown(raw).data;
		const after = parseMarkdown(setField(raw, 'status', 'draft')).data;
		expect(after).toEqual(before);
	});

	test('setting one field keeps the others and their order', () => {
		const raw = '---\ntitle: Hello\nstatus: draft\n---\nbody';
		const out = setField(raw, 'status', 'published');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			title: 'Hello',
			status: 'published',
		});
		expect(out.indexOf('title')).toBeLessThan(out.indexOf('status'));
	});

	test('clearing a field removes the key, never writes null', () => {
		const raw = '---\ntitle: Hello\nstatus: draft\n---\nbody';
		const out = setField(raw, 'status', undefined);
		expect(out).not.toContain('status');
		expect(out).not.toContain('null');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({ title: 'Hello' });
	});

	test('clearing the last field drops the fence to body-only', () => {
		expect(setField('---\ntitle: Hello\n---\n# Body\ntext', 'title', undefined)).toBe(
			'# Body\ntext',
		);
	});

	test('an invalid-against-the-model value survives by value (stays editable)', () => {
		// `duration` held as a string while the model wants an integer: still valid
		// YAML, so it round-trips and the grid keeps showing it INVALID to fix.
		const raw = '---\nduration: "1240s"\n---\nbody';
		const out = setField(raw, 'title', 'New');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			duration: '1240s',
			title: 'New',
		});
	});

	test('setting a field on a file with no frontmatter creates the block', () => {
		const out = setField('# Just a body\n\ntext', 'title', 'New');
		expect(parseMarkdown(out).data).toEqual({
			frontmatter: { title: 'New' },
			body: '# Just a body\n\ntext',
		});
	});

	test('editing the body keeps the frontmatter values', () => {
		const raw = '---\ntitle: Keep\nstatus: draft\n---\nold';
		expect(parseMarkdown(setBody(raw, 'new body')).data).toEqual({
			frontmatter: { title: 'Keep', status: 'draft' },
			body: 'new body',
		});
	});
});
