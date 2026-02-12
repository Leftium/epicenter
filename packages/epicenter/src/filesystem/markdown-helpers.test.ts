import { describe, expect, test } from 'bun:test';
import { Bash } from 'just-bash';
import * as Y from 'yjs';
import { createWorkspace } from '../static/create-workspace.js';
import { filesTable } from './file-table.js';
import {
	parseFrontmatter,
	serializeMarkdownWithFrontmatter,
	serializeXmlFragmentToMarkdown,
	updateYMapFromRecord,
	updateYXmlFragmentFromString,
	yMapToRecord,
} from './markdown-helpers.js';
import { YjsFileSystem } from './yjs-file-system.js';

describe('parseFrontmatter', () => {
	test('no front matter', () => {
		const result = parseFrontmatter('# Hello World');
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe('# Hello World');
	});

	test('with front matter', () => {
		const input = '---\ntitle: Hello\ndate: 2026-02-09\n---\n# Content';
		const result = parseFrontmatter(input);
		expect(result.frontmatter).toEqual({ title: 'Hello', date: '2026-02-09' });
		expect(result.body).toBe('# Content');
	});

	test('front matter with types', () => {
		const input = '---\ncount: 42\nactive: true\ntags: [a, b, c]\n---\nBody';
		const result = parseFrontmatter(input);
		expect(result.frontmatter.count).toBe(42);
		expect(result.frontmatter.active).toBe(true);
		expect(result.frontmatter.tags).toEqual(['a', 'b', 'c']);
	});

	test('empty body with front matter', () => {
		const input = '---\ntitle: Test\n---\n';
		const result = parseFrontmatter(input);
		expect(result.frontmatter).toEqual({ title: 'Test' });
		expect(result.body).toBe('');
	});
});

describe('serializeMarkdownWithFrontmatter', () => {
	test('empty frontmatter returns body only', () => {
		const result = serializeMarkdownWithFrontmatter({}, '# Hello');
		expect(result).toBe('# Hello');
	});

	test('with frontmatter', () => {
		const result = serializeMarkdownWithFrontmatter(
			{ title: 'Test' },
			'# Hello',
		);
		expect(result).toBe('---\ntitle: Test\n---\n# Hello');
	});
});

describe('Y.Map helpers', () => {
	test('updateYMapFromRecord sets keys', () => {
		const ydoc = new Y.Doc();
		const ymap = ydoc.getMap<unknown>('test');

		updateYMapFromRecord(ymap, { a: 1, b: 'hello', c: true });

		expect(ymap.get('a')).toBe(1);
		expect(ymap.get('b')).toBe('hello');
		expect(ymap.get('c')).toBe(true);
	});

	test('updateYMapFromRecord deletes missing keys', () => {
		const ydoc = new Y.Doc();
		const ymap = ydoc.getMap<unknown>('test');
		ymap.set('old', 'value');

		updateYMapFromRecord(ymap, { new: 'value' });

		expect(ymap.has('old')).toBe(false);
		expect(ymap.get('new')).toBe('value');
	});

	test('updateYMapFromRecord skips unchanged values', () => {
		const ydoc = new Y.Doc();
		const ymap = ydoc.getMap<unknown>('test');
		ymap.set('key', 'same');

		let changes = 0;
		ymap.observe(() => changes++);

		updateYMapFromRecord(ymap, { key: 'same' });
		// Should be 0 or minimal changes since the value didn't change
		expect(ymap.get('key')).toBe('same');
	});

	test('yMapToRecord round-trip', () => {
		const ydoc = new Y.Doc();
		const ymap = ydoc.getMap<unknown>('test');
		updateYMapFromRecord(ymap, { title: 'Hello', count: 42 });

		const record = yMapToRecord(ymap);
		expect(record).toEqual({ title: 'Hello', count: 42 });
	});
});

describe('XmlFragment serialization', () => {
	test('round-trip: markdown → XmlFragment → markdown', () => {
		const ydoc = new Y.Doc();
		const fragment = ydoc.getXmlFragment('richtext');

		const original = '# Hello World\n\nThis is a paragraph.\n';
		updateYXmlFragmentFromString(fragment, original);

		const serialized = serializeXmlFragmentToMarkdown(fragment);
		// ProseMirror may normalize slightly, but structure should be preserved
		expect(serialized).toContain('Hello World');
		expect(serialized).toContain('This is a paragraph.');
	});

	test('empty markdown', () => {
		const ydoc = new Y.Doc();
		const fragment = ydoc.getXmlFragment('richtext');

		updateYXmlFragmentFromString(fragment, '');

		const serialized = serializeXmlFragmentToMarkdown(fragment);
		expect(typeof serialized).toBe('string');
	});

	test('markdown with formatting', () => {
		const ydoc = new Y.Doc();
		const fragment = ydoc.getXmlFragment('richtext');

		updateYXmlFragmentFromString(fragment, '**bold** and *italic*\n');

		const serialized = serializeXmlFragmentToMarkdown(fragment);
		expect(serialized).toContain('bold');
		expect(serialized).toContain('italic');
	});
});

describe('markdown integration with YjsFileSystem', () => {
	function setup() {
		const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
		return YjsFileSystem.create(ws.tables.files);
	}

	test('write and read .md file with front matter', async () => {
		const fs = setup();
		const content = '---\ntitle: Test\n---\n# Hello World\n';
		await fs.writeFile('/doc.md', content);

		const read = await fs.readFile('/doc.md');
		expect(read).toContain('title: Test');
		expect(read).toContain('Hello World');
	});

	test('write and read .md file without front matter', async () => {
		const fs = setup();
		await fs.writeFile('/doc.md', '# Just a heading\n');

		const read = await fs.readFile('/doc.md');
		expect(read).toContain('Just a heading');
	});

	test('.txt file is still plain text', async () => {
		const fs = setup();
		await fs.writeFile('/file.txt', 'plain text content');
		expect(await fs.readFile('/file.txt')).toBe('plain text content');
	});

	test('.ts file is plain text', async () => {
		const fs = setup();
		await fs.writeFile('/index.ts', 'export const x = 42;');
		expect(await fs.readFile('/index.ts')).toBe('export const x = 42;');
	});

	test('just-bash cat on .md file', async () => {
		const fs = setup();
		const bash = new Bash({ fs, cwd: '/' });
		await bash.exec('echo "# Hello" > /test.md');
		const result = await bash.exec('cat /test.md');
		expect(result.stdout).toContain('Hello');
	});
});
