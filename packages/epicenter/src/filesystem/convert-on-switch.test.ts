import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createWorkspace } from '../static/create-workspace.js';
import type { TableHelper } from '../static/types.js';
import { filesTable } from './file-table.js';
import { createFileSystemIndex } from './file-system-index.js';
import { createContentDocStore } from './content-doc-store.js';
import { YjsFileSystem } from './yjs-file-system.js';
import type { FileRow } from './types.js';
import {
	getExtensionCategory,
	convertContentType,
	healContentType,
} from './convert-on-switch.js';
import { updateYXmlFragmentFromString, updateYMapFromRecord } from './markdown-helpers.js';

function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	const files = ws.tables.files as unknown as TableHelper<FileRow>;
	const index = createFileSystemIndex(files);
	const store = createContentDocStore();
	const fs = new YjsFileSystem(files, index, store);
	return { ws, files, index, store, fs };
}

describe('getExtensionCategory', () => {
	test('.md → richtext', () => {
		expect(getExtensionCategory('readme.md')).toBe('richtext');
		expect(getExtensionCategory('notes.md')).toBe('richtext');
	});

	test('everything else → text', () => {
		expect(getExtensionCategory('index.ts')).toBe('text');
		expect(getExtensionCategory('style.css')).toBe('text');
		expect(getExtensionCategory('hello.txt')).toBe('text');
		expect(getExtensionCategory('data.json')).toBe('text');
		expect(getExtensionCategory('.gitignore')).toBe('text');
	});

	test('same-category renames', () => {
		// .ts → .js stays text
		expect(getExtensionCategory('index.ts')).toBe(getExtensionCategory('index.js'));
	});
});

describe('convertContentType', () => {
	test('text → richtext', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, '---\ntitle: Hello\n---\n# Content\n');

		convertContentType(ydoc, 'text', 'richtext');

		const frontmatter = ydoc.getMap('frontmatter');
		expect(frontmatter.get('title')).toBe('Hello');

		const richtext = ydoc.getXmlFragment('richtext');
		expect(richtext.length).toBeGreaterThan(0);
	});

	test('text → richtext without frontmatter', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, '# Just a heading\n');

		convertContentType(ydoc, 'text', 'richtext');

		const frontmatter = ydoc.getMap('frontmatter');
		expect(frontmatter.size).toBe(0);

		const richtext = ydoc.getXmlFragment('richtext');
		expect(richtext.length).toBeGreaterThan(0);
	});

	test('richtext → text', () => {
		const ydoc = new Y.Doc();
		updateYMapFromRecord(ydoc.getMap('frontmatter'), { title: 'Test' });
		updateYXmlFragmentFromString(ydoc.getXmlFragment('richtext'), '# Hello World\n');

		convertContentType(ydoc, 'richtext', 'text');

		const text = ydoc.getText('text').toString();
		expect(text).toContain('title: Test');
		expect(text).toContain('Hello World');
		expect(text).toContain('---');
	});

	test('richtext → text without frontmatter', () => {
		const ydoc = new Y.Doc();
		updateYXmlFragmentFromString(ydoc.getXmlFragment('richtext'), '# Plain heading\n');

		convertContentType(ydoc, 'richtext', 'text');

		const text = ydoc.getText('text').toString();
		expect(text).toContain('Plain heading');
		expect(text).not.toContain('---');
	});

	test('same category is no-op', () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText('text');
		ytext.insert(0, 'hello');

		convertContentType(ydoc, 'text', 'text');

		expect(ytext.toString()).toBe('hello');
	});
});

describe('healContentType', () => {
	test('heals .md file with content in text key', () => {
		const ydoc = new Y.Doc();
		ydoc.getText('text').insert(0, '# Hello\n');

		healContentType(ydoc, 'readme.md');

		// Content should now be in richtext
		expect(ydoc.getXmlFragment('richtext').length).toBeGreaterThan(0);
	});

	test('heals .ts file with content in richtext key', () => {
		const ydoc = new Y.Doc();
		updateYXmlFragmentFromString(ydoc.getXmlFragment('richtext'), 'export const x = 42;\n');

		healContentType(ydoc, 'index.ts');

		// Content should now be in text
		expect(ydoc.getText('text').toString()).toContain('export const x = 42');
	});

	test('no-op when content already in correct type', () => {
		const ydoc = new Y.Doc();
		updateYXmlFragmentFromString(ydoc.getXmlFragment('richtext'), '# Hello\n');

		healContentType(ydoc, 'readme.md');

		// Should still have richtext content (unchanged)
		expect(ydoc.getXmlFragment('richtext').length).toBeGreaterThan(0);
	});

	test('no-op on empty doc', () => {
		const ydoc = new Y.Doc();

		// Should not throw on empty doc
		healContentType(ydoc, 'empty.md');
		healContentType(ydoc, 'empty.ts');
	});
});

describe('convert-on-switch via YjsFileSystem.mv()', () => {
	test('.txt → .md converts text to richtext', async () => {
		const { fs } = setup();
		await fs.writeFile('/hello.txt', '---\ntitle: Hello\n---\n# Content\n');

		await fs.mv('/hello.txt', '/hello.md');

		const read = await fs.readFile('/hello.md');
		expect(read).toContain('title: Hello');
		expect(read).toContain('Content');
	});

	test('.md → .txt converts richtext to text', async () => {
		const { fs } = setup();
		await fs.writeFile('/doc.md', '---\ntitle: Test\n---\n# Hello\n');

		await fs.mv('/doc.md', '/doc.txt');

		const read = await fs.readFile('/doc.txt');
		expect(read).toContain('title: Test');
		expect(read).toContain('Hello');
	});

	test('round-trip .txt → .md → .txt preserves content', async () => {
		const { fs } = setup();
		const original = '# Hello World\n';
		await fs.writeFile('/file.txt', original);

		await fs.mv('/file.txt', '/file.md');
		await fs.mv('/file.md', '/file.txt');

		const read = await fs.readFile('/file.txt');
		expect(read).toContain('Hello World');
	});

	test('.ts → .js does NOT trigger conversion (same category)', async () => {
		const { fs } = setup();
		await fs.writeFile('/index.ts', 'export const x = 42;');

		await fs.mv('/index.ts', '/index.js');

		expect(await fs.readFile('/index.js')).toBe('export const x = 42;');
	});

	test('.md → .md rename does NOT trigger conversion', async () => {
		const { fs } = setup();
		await fs.writeFile('/old.md', '# Hello\n');

		await fs.mv('/old.md', '/new.md');

		const read = await fs.readFile('/new.md');
		expect(read).toContain('Hello');
	});
});
