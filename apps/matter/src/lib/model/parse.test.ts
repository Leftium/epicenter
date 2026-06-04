import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';

describe('parseMarkdown', () => {
	test('splits frontmatter from body', () => {
		const result = parseMarkdown('---\ntitle: Hello\nstatus: draft\n---\n# Body\n\ntext');
		expect(result).toEqual({
			ok: true,
			frontmatter: { title: 'Hello', status: 'draft' },
			body: '# Body\n\ntext',
		});
	});

	test('no frontmatter is an empty mapping and the whole file is body', () => {
		const result = parseMarkdown('# Just a heading\n\nno frontmatter here');
		expect(result).toEqual({
			ok: true,
			frontmatter: {},
			body: '# Just a heading\n\nno frontmatter here',
		});
	});

	test('empty frontmatter block parses to an empty mapping', () => {
		const result = parseMarkdown('---\n---\nbody');
		expect(result).toEqual({ ok: true, frontmatter: {}, body: 'body' });
	});

	test('parses YAML scalar types (numbers, booleans, lists)', () => {
		const result = parseMarkdown(
			'---\nduration: 12.4\npublished: true\ntags:\n  - a\n  - b\n---\nbody',
		);
		expect(result).toMatchObject({
			ok: true,
			frontmatter: { duration: 12.4, published: true, tags: ['a', 'b'] },
		});
	});

	test('YAML 1.2: "NO" stays a string (no Norway-problem coercion)', () => {
		const result = parseMarkdown('---\ncountry: NO\n---\nbody');
		expect(result).toMatchObject({ ok: true, frontmatter: { country: 'NO' } });
	});

	test('conflict markers are unreadable, never silently parsed', () => {
		const raw = '---\ntitle: x\n<<<<<<< HEAD\nstatus: a\n=======\nstatus: b\n>>>>>>> other\n---\nbody';
		expect(parseMarkdown(raw)).toEqual({ ok: false, reason: 'conflict-markers', raw });
	});

	test('malformed YAML is unreadable', () => {
		const raw = '---\n: : :\n  bad\n indent\n---\nbody';
		const result = parseMarkdown(raw);
		expect(result.ok).toBe(false);
	});

	test('frontmatter that is not a mapping (a list) is unreadable', () => {
		const raw = '---\n- a\n- b\n---\nbody';
		expect(parseMarkdown(raw)).toMatchObject({ ok: false, reason: 'invalid-yaml' });
	});
});
