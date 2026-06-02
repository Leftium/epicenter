/**
 * Markdown Vault Tests
 *
 * Covers the continuous materialize observer and the destructive `rebuild`
 * mutation on `attachMarkdownVault`. The declarative `apply` reconcile
 * (disk -> Yjs) is tested separately in `apply.test.ts`. Uses real temp
 * directories and Yjs workspaces so the vault exercises actual table
 * set/get and filesystem paths.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	createDisposableCache,
	createWorkspace,
	defineTable,
	type Tables,
} from '../../../index.js';
import { column } from '../../column/index.js';
import { attachMarkdownVault, type VaultTablesConfig } from './vault.js';

// ============================================================================
// Test Table Definitions
// ============================================================================

const postsTable = defineTable({
	id: column.string(),
	title: column.string(),
	published: column.boolean(),
});

const notesTable = defineTable({
	id: column.string(),
	body: column.string(),
});

const tableDefinitions = { posts: postsTable, notes: notesTable };

// ============================================================================
// Test Directory Setup
// ============================================================================

const TEST_DIR = join(import.meta.dir, '__test-vault__');

beforeEach(async () => {
	await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

async function writeTestFile(relativePath: string, content: string) {
	const fullPath = join(TEST_DIR, relativePath);
	await mkdir(join(fullPath, '..'), { recursive: true });
	await writeFile(fullPath, content, 'utf-8');
}

async function readTestFile(relativePath: string) {
	return readFile(join(TEST_DIR, relativePath), 'utf-8');
}

async function listTestDir(relativePath: string) {
	return readdir(join(TEST_DIR, relativePath));
}

/**
 * Poll until `relativePath` exists and its content satisfies `predicate`, or the
 * deadline elapses. The materialize observer writes are detached, so a fixed
 * sleep is flaky on a cold run; this waits for the write to actually land (which
 * also means `fileState` is populated, so the dirty guard is armed).
 */
async function waitForContent(
	relativePath: string,
	predicate: (content: string) => boolean,
	timeoutMs = 2_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const content = await readTestFile(relativePath);
			if (predicate(content)) return content;
		} catch {
			// not written yet
		}
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${relativePath}`);
}

type SetupOptions = {
	tables?: VaultTablesConfig<Tables<typeof tableDefinitions>>;
};

async function setup({ tables = { posts: {}, notes: {} } }: SetupOptions = {}) {
	const cache = createDisposableCache(
		(id: string) => {
			const inner = createWorkspace({
				id,
				tables: tableDefinitions,
				kv: {},
			});

			const materializer = attachMarkdownVault(inner, {
				dir: TEST_DIR,
				tables,
			});

			return {
				ydoc: inner.ydoc,
				tables: inner.tables,
				materializer,
				whenReady: materializer.whenFlushed,
				[Symbol.dispose]() {
					inner[Symbol.dispose]();
				},
			};
		},
		{ gcTime: 0 },
	);

	const workspace = cache.open('test-vault');
	await workspace.whenReady;
	return { workspace, cache };
}

// ============================================================================
// rebuild Tests
// ============================================================================

describe('rebuild', () => {
	test('removes orphan files and rewrites existing valid rows', async () => {
		const { workspace } = await setup({ tables: { posts: {} } });
		// Seed disk with rows + an orphan file
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Live',
			published: true,
		});
		await workspace.materializer.actions.markdown_rebuild({});
		await writeTestFile(
			'posts/orphan.md',
			'---\nid: orphan\ntitle: Orphan\npublished: false\n---\n',
		);

		const before = await listTestDir('posts');
		expect(before).toContain('p1.md');
		expect(before).toContain('orphan.md');

		const result = await workspace.materializer.actions.markdown_rebuild({});

		expect(result.deleted).toBe(2); // p1.md + orphan.md both unlinked
		expect(result.written).toBe(1); // only p1 re-written

		const after = await listTestDir('posts');
		expect(after).toContain('p1.md');
		expect(after).not.toContain('orphan.md');

		workspace[Symbol.dispose]();
	});

	test('rebuild with table argument only touches that table', async () => {
		const { workspace } = await setup();
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Post',
			published: false,
		});
		workspace.tables.notes.set({ id: 'n1', body: 'Note' });
		await workspace.materializer.actions.markdown_rebuild({});
		await writeTestFile('notes/orphan.md', '---\nid: x\nbody: gone\n---\n');

		const result = await workspace.materializer.actions.markdown_rebuild({
			tableName: 'posts',
		});

		expect(result.deleted).toBe(1); // p1.md
		expect(result.written).toBe(1); // p1 re-written

		// notes/ is untouched; orphan still there
		const notesEntries = await listTestDir('notes');
		expect(notesEntries).toContain('orphan.md');

		workspace[Symbol.dispose]();
	});

	test('throws on unknown table name', async () => {
		const { workspace } = await setup({ tables: { posts: {} } });
		await expect(
			workspace.materializer.actions.markdown_rebuild({
				tableName: 'notAThing',
			}),
		).rejects.toThrow(/not in the vault's table set/);

		workspace[Symbol.dispose]();
	});

	test('aborts WITHOUT deleting existing files when a row fails to serialize', async () => {
		// readBody throws (mimics fuji's body read hitting its connect deadline).
		const { workspace } = await setup({
			tables: {
				posts: {
					readBody: () => {
						throw new Error('simulated body read failure');
					},
				},
			},
		});
		workspace.tables.posts.set({ id: 'p1', title: 'Keep', published: true });

		// A file already on disk that a failed rebuild must NOT wipe.
		await writeTestFile(
			'posts/p1.md',
			'---\nid: p1\ntitle: Keep\npublished: true\n---\n',
		);

		// Rebuild renders every row BEFORE sweeping the directory, so the throwing
		// row aborts the rebuild with the existing file still intact, instead of
		// deleting everything and then failing to rewrite it.
		await expect(
			workspace.materializer.actions.markdown_rebuild({}),
		).rejects.toThrow();

		const after = await listTestDir('posts');
		expect(after).toContain('p1.md');

		workspace[Symbol.dispose]();
	});

	test('is idempotent: rebuild twice produces identical filesystem state', async () => {
		const { workspace } = await setup({ tables: { posts: {} } });
		workspace.tables.posts.set({
			id: 'p1',
			title: 'A',
			published: true,
		});
		workspace.tables.posts.set({
			id: 'p2',
			title: 'B',
			published: false,
		});

		const first = await workspace.materializer.actions.markdown_rebuild({});
		const stateAfterFirst = await listTestDir('posts');
		const contentsAfterFirst = await Promise.all(
			stateAfterFirst.map((f) => readTestFile(`posts/${f}`)),
		);

		const second = await workspace.materializer.actions.markdown_rebuild({});
		const stateAfterSecond = await listTestDir('posts');
		const contentsAfterSecond = await Promise.all(
			stateAfterSecond.map((f) => readTestFile(`posts/${f}`)),
		);

		// On the first rebuild, written=2 and deleted=0 (no files existed).
		// On the second, deleted=2 (wipes the first's output) and written=2.
		expect(first.written).toBe(2);
		expect(second.written).toBe(2);
		expect(second.deleted).toBe(2);

		expect(stateAfterSecond).toEqual(stateAfterFirst);
		expect(contentsAfterSecond).toEqual(contentsAfterFirst);

		workspace[Symbol.dispose]();
	});
});

// ============================================================================
// Observer per-row isolation
// ============================================================================

describe('observer per-row isolation', () => {
	test('a throwing readBody for one changed row does not block its batch siblings', async () => {
		const workspace = createWorkspace({
			id: 'obs-isolation',
			tables: tableDefinitions,
			kv: {},
		});

		const materializer = attachMarkdownVault(workspace, {
			dir: TEST_DIR,
			tables: {
				posts: {
					readBody: (row) => {
						if (row.id === 'bad') {
							throw new Error('simulated body read failure');
						}
						return '';
					},
				},
			},
		});
		await materializer.whenFlushed;

		// Both rows change in ONE transaction, so the observer receives them in a
		// single `changedIds` batch with `bad` first. The throwing row must skip
		// itself only and leave its sibling to materialize.
		await workspace.tables.posts.bulkSet([
			{ id: 'bad', title: 'Bad', published: true },
			{ id: 'good', title: 'Good', published: true },
		]);

		// Wait for the detached observer writes to settle.
		await Bun.sleep(20);

		const files = await listTestDir('posts');
		expect(files).toContain('good.md');
		expect(files).not.toContain('bad.md');

		workspace[Symbol.dispose]();
	});
});

// ============================================================================
// Dirty guard: continuous materialize must not stomp in-progress edits
// ============================================================================

describe('dirty guard', () => {
	test('a locally edited file survives a remote row change (left for apply)', async () => {
		const { workspace } = await setup({ tables: { posts: {} } });
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Original',
			published: true,
		});
		// Wait for the observer write to land (so fileState is populated and the
		// dirty guard is armed) before editing on disk.
		await waitForContent('posts/p1.md', (c) => c.includes('title: Original'));

		// A human or agent edits the vault file on disk.
		await writeTestFile(
			'posts/p1.md',
			'---\nid: p1\ntitle: LOCAL EDIT\npublished: true\n---\n',
		);

		// A change to the same row (e.g. a remote sync) fires the observer. The
		// guard skips the overwrite whenever the observer runs, so the assertion
		// holds regardless of timing.
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Remote Change',
			published: false,
		});
		await Bun.sleep(40);

		const onDisk = await readTestFile('posts/p1.md');
		expect(onDisk).toContain('LOCAL EDIT');
		expect(onDisk).not.toContain('Remote Change');

		workspace[Symbol.dispose]();
	});

	test('a clean (unedited) file is updated normally on a row change', async () => {
		const { workspace } = await setup({ tables: { posts: {} } });
		workspace.tables.posts.set({
			id: 'p1',
			title: 'Original',
			published: true,
		});
		await waitForContent('posts/p1.md', (c) => c.includes('title: Original'));

		// No local edit: a row change rewrites the file as usual.
		workspace.tables.posts.set({ id: 'p1', title: 'Updated', published: true });
		await waitForContent('posts/p1.md', (c) => c.includes('title: Updated'));

		expect(await readTestFile('posts/p1.md')).toContain('title: Updated');

		workspace[Symbol.dispose]();
	});
});
