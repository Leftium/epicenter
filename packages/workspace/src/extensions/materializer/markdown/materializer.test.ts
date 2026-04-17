/**
 * Markdown Materializer Bidirectional Sync Tests
 *
 * Tests the `pushFromMarkdown` and `pullToMarkdown` methods added to
 * `createMarkdownMaterializer`. Uses an in-memory IO adapter and real
 * Yjs workspace so the materializer exercises actual table set/get paths.
 *
 * Key behaviors:
 * - pushFromMarkdown reads `.md` files, parses frontmatter, and calls table.set()
 * - pushFromMarkdown skips non-`.md` files and files without valid frontmatter
 * - pushFromMarkdown reports errors for unreadable files
 * - pushFromMarkdown uses custom deserialize callback when provided
 * - pushFromMarkdown silently skips tables whose directories don't exist
 * - pullToMarkdown re-serializes all valid rows to disk
 * - pullToMarkdown uses custom serialize callback when provided
 * - Round-trip: pullToMarkdown → pushFromMarkdown preserves data
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { createWorkspace, defineTable } from '../../../workspace/index.js';
import { createMarkdownMaterializer } from './materializer.js';
import type { MaterializerIO, MaterializerYaml } from './materializer.js';

// ============================================================================
// Test Table Definitions
// ============================================================================

const postsTable = defineTable(
	type({ id: 'string', title: 'string', published: 'boolean', _v: '1' }),
);

const notesTable = defineTable(type({ id: 'string', body: 'string', _v: '1' }));

// ============================================================================
// In-Memory IO + YAML Adapters
// ============================================================================

type MemoryFS = Map<string, string | string[]>;

function createMemoryIO(fs: MemoryFS): MaterializerIO {
	return {
		async mkdir(dir) {
			if (!fs.has(dir)) fs.set(dir, []);
		},
		async writeFile(path, content) {
			fs.set(path, content);
			// Track filename in parent directory listing
			const lastSlash = path.lastIndexOf('/');
			const parentDir = path.slice(0, lastSlash);
			const filename = path.slice(lastSlash + 1);
			const entries = fs.get(parentDir);
			if (Array.isArray(entries) && !entries.includes(filename)) {
				entries.push(filename);
			}
		},
		async readFile(path) {
			const content = fs.get(path);
			if (typeof content !== 'string') throw new Error(`ENOENT: ${path}`);
			return content;
		},
		async readdir(dir) {
			const entries = fs.get(dir);
			if (!Array.isArray(entries)) throw new Error(`ENOENT: ${dir}`);
			return [...entries];
		},
		async removeFile(path) {
			fs.delete(path);
			// Clean up parent directory listing
			const lastSlash = path.lastIndexOf('/');
			const parentDir = path.slice(0, lastSlash);
			const filename = path.slice(lastSlash + 1);
			const entries = fs.get(parentDir);
			if (Array.isArray(entries)) {
				const idx = entries.indexOf(filename);
				if (idx !== -1) entries.splice(idx, 1);
			}
		},
		joinPath(...segments) {
			return segments.join('/');
		},
	};
}

function createTestYaml(): MaterializerYaml {
	const { YAML } = require('bun') as typeof import('bun');
	return {
		stringify: (obj) => YAML.stringify(obj, null, 2) as string,
		parse: (str) => YAML.parse(str) as unknown,
	};
}

// ============================================================================
// Setup
// ============================================================================

function setup(options?: {
	tables?: Array<{
		name: string;
		config?: Parameters<
			ReturnType<typeof createMarkdownMaterializer>['table']
		>[1];
	}>;
}) {
	const fs: MemoryFS = new Map();
	const io = createMemoryIO(fs);
	const yaml = createTestYaml();

	const workspace = createWorkspace({
		id: 'test.materializer',
		tables: { posts: postsTable, notes: notesTable },
	}).withWorkspaceExtension('materializer', (ctx) => {
		const materializer = createMarkdownMaterializer(ctx, {
			dir: '/test-data',
			io,
			yaml,
		});

		const tablesToRegister = options?.tables ?? [
			{ name: 'posts' },
			{ name: 'notes' },
		];
		for (const { name, config } of tablesToRegister) {
			materializer.table(name, config);
		}

		return materializer;
	});

	return { fs, workspace };
}

/**
 * Seed in-memory filesystem with markdown files for a table directory.
 * Each entry is `[filename, content]`.
 */
function seedFiles(fs: MemoryFS, dir: string, files: Array<[string, string]>) {
	const filenames: string[] = [];
	for (const [filename, content] of files) {
		fs.set(`${dir}/${filename}`, content);
		filenames.push(filename);
	}
	fs.set(dir, filenames);
}

// ============================================================================
// pushFromMarkdown Tests
// ============================================================================

describe('pushFromMarkdown', () => {
	test('imports markdown files into workspace tables', async () => {
		const { fs, workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		seedFiles(fs, '/test-data/posts', [
			[
				'hello.md',
				'---\nid: post-1\ntitle: Hello World\npublished: true\n_v: 1\n---\n',
			],
			[
				'draft.md',
				'---\nid: post-2\ntitle: Draft Post\npublished: false\n_v: 1\n---\n',
			],
		]);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.errors).toEqual([]);

		const post1 = workspace.tables.posts.get('post-1');
		expect(post1.status).toBe('valid');
		if (post1.status === 'valid') {
			expect(post1.row.title).toBe('Hello World');
			expect(post1.row.published).toBe(true);
		}

		const post2 = workspace.tables.posts.get('post-2');
		expect(post2.status).toBe('valid');
		if (post2.status === 'valid') {
			expect(post2.row.title).toBe('Draft Post');
		}
	});

	test('skips non-.md files', async () => {
		const { fs, workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		seedFiles(fs, '/test-data/posts', [
			['valid.md', '---\nid: p1\ntitle: Valid\npublished: false\n_v: 1\n---\n'],
			['readme.txt', 'not a markdown file'],
			['data.json', '{"id": "test"}'],
		]);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
	});

	test('skips files without valid frontmatter', async () => {
		const { fs, workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		seedFiles(fs, '/test-data/posts', [
			['valid.md', '---\nid: p1\ntitle: Valid\npublished: false\n_v: 1\n---\n'],
			['no-frontmatter.md', '# Just a heading\n\nSome content\n'],
		]);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(1);
	});

	test('reports errors for unreadable files', async () => {
		const { fs, workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		// Seed directory listing with a file that doesn't exist in fs
		fs.set('/test-data/posts', ['ghost.md']);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(0);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain('ghost.md');
	});

	test('silently skips tables whose directories do not exist', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		// Don't seed any filesystem entries — directory doesn't exist
		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.errors).toEqual([]);
	});

	test('uses custom deserialize callback', async () => {
		const { fs, workspace } = setup({
			tables: [
				{
					name: 'notes',
					config: {
						deserialize: (parsed) => ({
							id: parsed.frontmatter.id as string,
							body: parsed.body ?? '',
							_v: 1 as const,
						}),
					},
				},
			],
		});
		await workspace.whenReady;

		seedFiles(fs, '/test-data/notes', [
			['my-note.md', '---\nid: note-1\n---\n\nThis is the body content\n'],
		]);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);

		const note = workspace.tables.notes.get('note-1');
		expect(note.status).toBe('valid');
		if (note.status === 'valid') {
			expect(note.row.body).toBe('This is the body content');
		}
	});

	test('uses custom table directory', async () => {
		const { fs, workspace } = setup({
			tables: [{ name: 'posts', config: { dir: 'blog' } }],
		});
		await workspace.whenReady;

		seedFiles(fs, '/test-data/blog', [
			['hello.md', '---\nid: p1\ntitle: Hello\npublished: false\n_v: 1\n---\n'],
		]);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(1);
		expect(workspace.tables.posts.has('p1')).toBe(true);
	});

	test('overwrites existing rows (set is insert-or-replace)', async () => {
		const { fs, workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		// First import: seed a file and import it
		seedFiles(fs, '/test-data/posts', [
			['p1.md', '---\nid: p1\ntitle: Original\npublished: false\n_v: 1\n---\n'],
		]);

		const first = await workspace.extensions.materializer.pushFromMarkdown();
		expect(first.imported).toBe(1);

		const originalPost = workspace.tables.posts.get('p1');
		expect(originalPost.status).toBe('valid');
		if (originalPost.status === 'valid') {
			expect(originalPost.row.title).toBe('Original');
		}

		// Flush observer microtasks (observer writes files on table.set() from the first push)
		await Bun.sleep(0);

		// Second import: overwrite the same file with different data
		fs.set('/test-data/posts/p1.md', '---\nid: p1\ntitle: Updated From Disk\npublished: true\n_v: 1\n---\n');

		const second = await workspace.extensions.materializer.pushFromMarkdown();
		expect(second.imported).toBe(1);

		const updatedPost = workspace.tables.posts.get('p1');
		expect(updatedPost.status).toBe('valid');
		if (updatedPost.status === 'valid') {
			expect(updatedPost.row.title).toBe('Updated From Disk');
			expect(updatedPost.row.published).toBe(true);
		}
	});

	test('imports across multiple tables', async () => {
		const { fs, workspace } = setup();
		await workspace.whenReady;

		seedFiles(fs, '/test-data/posts', [
			['post.md', '---\nid: p1\ntitle: Post\npublished: false\n_v: 1\n---\n'],
		]);
		seedFiles(fs, '/test-data/notes', [
			['note.md', '---\nid: n1\nbody: Note body\n_v: 1\n---\n'],
		]);

		const result = await workspace.extensions.materializer.pushFromMarkdown();

		expect(result.imported).toBe(2);
		expect(workspace.tables.posts.has('p1')).toBe(true);
		expect(workspace.tables.notes.has('n1')).toBe(true);
	});
});

// ============================================================================
// pullToMarkdown Tests
// ============================================================================

describe('pullToMarkdown', () => {
	test('writes all valid rows to disk', async () => {
		const { fs, workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'First',
			published: true,
			_v: 1,
		});
		workspace.tables.posts.set({
			id: 'p2',
			title: 'Second',
			published: false,
			_v: 1,
		});

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(2);

		// Verify files were written
		const content1 = fs.get('/test-data/posts/p1.md');
		expect(typeof content1).toBe('string');
		expect(content1 as string).toContain('title: First');

		const content2 = fs.get('/test-data/posts/p2.md');
		expect(typeof content2).toBe('string');
		expect(content2 as string).toContain('title: Second');
	});

	test('creates table directory before writing', async () => {
		const { fs, workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'First',
			published: false,
			_v: 1,
		});

		await workspace.extensions.materializer.pullToMarkdown();

		// Directory should exist
		expect(fs.has('/test-data/posts')).toBe(true);
	});

	test('uses custom serialize callback', async () => {
		const { fs, workspace } = setup({
			tables: [
				{
					name: 'notes',
					config: {
						serialize: (row) => ({
							filename: `${row.id}-custom.md`,
							content: `---\nid: ${row.id}\n---\n\n${row.body}\n`,
						}),
					},
				},
			],
		});
		await workspace.whenReady;

		workspace.tables.notes.set({ id: 'n1', body: 'Custom body', _v: 1 });

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(1);
		expect(fs.has('/test-data/notes/n1-custom.md')).toBe(true);

		const content = fs.get('/test-data/notes/n1-custom.md') as string;
		expect(content).toContain('Custom body');
	});

	test('uses custom table directory', async () => {
		const { fs, workspace } = setup({
			tables: [{ name: 'posts', config: { dir: 'blog' } }],
		});
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'Blog Post',
			published: false,
			_v: 1,
		});

		await workspace.extensions.materializer.pullToMarkdown();

		expect(fs.has('/test-data/blog/p1.md')).toBe(true);
	});

	test('writes nothing when table is empty', async () => {
		const { workspace } = setup({ tables: [{ name: 'posts' }] });
		await workspace.whenReady;

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(0);
	});

	test('writes across multiple tables', async () => {
		const { fs, workspace } = setup();
		await workspace.whenReady;

		workspace.tables.posts.set({
			id: 'p1',
			title: 'Post',
			published: false,
			_v: 1,
		});
		workspace.tables.notes.set({ id: 'n1', body: 'Note', _v: 1 });

		const result = await workspace.extensions.materializer.pullToMarkdown();

		expect(result.written).toBe(2);
		expect(fs.has('/test-data/posts/p1.md')).toBe(true);
		expect(fs.has('/test-data/notes/n1.md')).toBe(true);
	});
});

// ============================================================================
// Round-Trip Tests
// ============================================================================

describe('round-trip', () => {
	test('pullToMarkdown then pushFromMarkdown on fresh workspace preserves row data', async () => {
		const fs: MemoryFS = new Map();
		const io = createMemoryIO(fs);
		const yaml = createTestYaml();

		// First workspace: populate and pull to disk
		const workspace1 = createWorkspace({
			id: 'test.roundtrip.1',
			tables: { posts: postsTable, notes: notesTable },
		}).withWorkspaceExtension('materializer', (ctx) =>
			createMarkdownMaterializer(ctx, { dir: '/test-data', io, yaml }).table('posts'),
		);
		await workspace1.whenReady;

		workspace1.tables.posts.set({ id: 'p1', title: 'Round Trip', published: true, _v: 1 });
		workspace1.tables.posts.set({ id: 'p2', title: 'Another', published: false, _v: 1 });

		await workspace1.extensions.materializer.pullToMarkdown();
		workspace1.extensions.materializer.dispose();

		// Second workspace: fresh instance, push from the same FS
		const workspace2 = createWorkspace({
			id: 'test.roundtrip.2',
			tables: { posts: postsTable, notes: notesTable },
		}).withWorkspaceExtension('materializer', (ctx) =>
			createMarkdownMaterializer(ctx, { dir: '/test-data', io, yaml }).table('posts'),
		);
		await workspace2.whenReady;

		const result = await workspace2.extensions.materializer.pushFromMarkdown();
		expect(result.imported).toBe(2);

		const p1 = workspace2.tables.posts.get('p1');
		expect(p1.status).toBe('valid');
		if (p1.status === 'valid') {
			expect(p1.row.title).toBe('Round Trip');
			expect(p1.row.published).toBe(true);
		}

		const p2 = workspace2.tables.posts.get('p2');
		expect(p2.status).toBe('valid');
		if (p2.status === 'valid') {
			expect(p2.row.title).toBe('Another');
			expect(p2.row.published).toBe(false);
		}
	});
});
