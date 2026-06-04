import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';
import { setBody, setField } from './serialize';

describe('setField', () => {
	test('round-trip identity: a no-op edit preserves comments, order, and quoting', () => {
		const raw = [
			'---',
			'# the post title',
			'title: "001"', // quoted so it stays a string, not the int 1
			'status: draft',
			'count: 3',
			'---',
			'# Body',
		].join('\n');
		// Re-set a key to its current value: nothing the user did not touch may move.
		const out = setField(raw, 'status', 'draft');
		expect(out).toContain('# the post title');
		expect(out).toContain('title: "001"');
		// Order is preserved (title before status before count).
		expect(out.indexOf('title')).toBeLessThan(out.indexOf('status'));
		expect(out.indexOf('status')).toBeLessThan(out.indexOf('count'));
		// And it still parses to the same values.
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			title: '001',
			status: 'draft',
			count: 3,
		});
	});

	test('editing one field leaves another field\'s comment intact', () => {
		const raw = '---\ntitle: Old # keep me\nstatus: draft\n---\nbody';
		const out = setField(raw, 'status', 'published');
		expect(out).toContain('# keep me');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			title: 'Old',
			status: 'published',
		});
	});

	test('the edited value\'s JS type becomes its YAML type', () => {
		const raw = '---\ntitle: x\n---\nbody';
		// A number stays bare; a numeric-looking string stays quoted (a string).
		expect(parseMarkdown(setField(raw, 'count', 3)).data?.frontmatter).toEqual({
			title: 'x',
			count: 3,
		});
		expect(parseMarkdown(setField(raw, 'code', '007')).data?.frontmatter).toEqual({
			title: 'x',
			code: '007',
		});
	});

	test('clearing a field removes the key, never writes null', () => {
		const raw = '---\ntitle: Hello\nstatus: draft\n---\nbody';
		const out = setField(raw, 'status', undefined);
		expect(out).not.toContain('status');
		expect(out).not.toContain('null');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({ title: 'Hello' });
	});

	test('clearing the last field drops the frontmatter fence to body-only', () => {
		const raw = '---\ntitle: Hello\n---\n# Body\ntext';
		const out = setField(raw, 'title', undefined);
		expect(out).toBe('# Body\ntext');
	});

	test('setting a field on a file with no frontmatter creates the block', () => {
		const raw = '# Just a body\n\ntext';
		const out = setField(raw, 'title', 'New');
		expect(parseMarkdown(out).data).toEqual({
			frontmatter: { title: 'New' },
			body: '# Just a body\n\ntext',
		});
	});

	test('adding a key preserves the existing keys and their order', () => {
		const raw = '---\ntitle: Hello\nstatus: draft\n---\nbody';
		const out = setField(raw, 'tags', ['a', 'b']);
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			title: 'Hello',
			status: 'draft',
			tags: ['a', 'b'],
		});
		expect(out.indexOf('title')).toBeLessThan(out.indexOf('status'));
	});
});

describe('setBody', () => {
	test('replaces the body and keeps the frontmatter block byte-for-byte', () => {
		const raw = '---\n# a comment\ntitle: "001"\n---\nold body';
		const out = setBody(raw, '# New body\n\nmore');
		expect(out).toBe('---\n# a comment\ntitle: "001"\n---\n# New body\n\nmore');
	});

	test('a no-op body write is byte-identical', () => {
		const raw = '---\ntitle: x\n---\n# Body\ntext';
		const { data } = parseMarkdown(raw);
		expect(setBody(raw, data?.body ?? '')).toBe(raw);
	});

	test('with no frontmatter the body is the whole file', () => {
		expect(setBody('all body, no fm', 'new body')).toBe('new body');
	});

	test('editing the body never touches the frontmatter', () => {
		const raw = '---\ntitle: Keep\nstatus: draft\n---\nbody';
		const out = setBody(raw, 'changed');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			title: 'Keep',
			status: 'draft',
		});
	});
});
