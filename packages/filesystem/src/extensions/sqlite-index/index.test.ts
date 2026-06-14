/**
 * SQLite Index Tests
 *
 * Verifies the SQLite mirror converges its `path` column to the runtime
 * FileSystemIndex, the single owner of path and parent-graph validity.
 *
 * Key behaviors:
 * - Mirrored paths match the index exactly, including name disambiguation.
 * - Trashed rows stay mirrored but carry a null path.
 * - Path ripples (folder renames, sibling re-disambiguation) converge even
 *   when the rippled rows themselves never changed.
 */

import { describe, expect, test } from 'bun:test';
import { createWorkspace } from '@epicenter/workspace';
import { asFileId } from '../../ids.js';
import { filesTable } from '../../table.js';
import { attachFileSystemIndex } from '../../tree/path-index.js';
import { createSqliteIndex, type SqliteIndex } from './index.js';

const fid = (s: string) => asFileId(s);

function makeRow(
	id: string,
	name: string,
	parentId: string | null = null,
	type: 'file' | 'folder' = 'file',
) {
	return {
		id: fid(id),
		name,
		parentId: parentId === null ? null : fid(parentId),
		type,
		size: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		trashedAt: null,
	};
}

function setup() {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
		kv: {},
	});
	const index = attachFileSystemIndex(workspace.ydoc, workspace.tables.files);
	const sqlite = createSqliteIndex(
		{ readContent: async () => '', index },
		{ debounceMs: 1 },
	)({ tables: workspace.tables });
	return {
		files: workspace.tables.files,
		ydoc: workspace.ydoc,
		sqlite,
		async teardown() {
			sqlite[Symbol.dispose]();
			workspace.ydoc.destroy();
		},
	};
}

async function mirroredPaths(
	sqlite: SqliteIndex,
): Promise<Map<string, string | null>> {
	const result = await sqlite.exports.client.execute(
		'SELECT id, path FROM files',
	);
	return new Map(
		result.rows.map((row) => [
			row.id as string,
			(row.path as string | null) ?? null,
		]),
	);
}

/** Poll until the assertion passes or the deadline hits (debounced syncs). */
async function eventually(assert: () => Promise<void>): Promise<void> {
	const deadline = Date.now() + 2000;
	for (;;) {
		try {
			await assert();
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

describe('createSqliteIndex', () => {
	test('rebuild mirrors index paths, including disambiguated names', async () => {
		const { files, sqlite, teardown } = setup();
		files.set(makeRow('d1', 'docs', null, 'folder'));
		files.set(makeRow('f1', 'api.md', 'd1'));
		files.set({ ...makeRow('a', 'foo.txt'), createdAt: 1000 });
		files.set({ ...makeRow('b', 'foo.txt'), createdAt: 2000 });
		await sqlite.exports.whenReady;

		const paths = await mirroredPaths(sqlite);
		expect(paths.get('d1')).toBe('/docs');
		expect(paths.get('f1')).toBe('/docs/api.md');
		expect(paths.get('a')).toBe('/foo.txt');
		expect(paths.get('b')).toBe('/foo (1).txt');

		await teardown();
	});

	test('trashed rows stay mirrored with a null path', async () => {
		const { files, sqlite, teardown } = setup();
		files.set(makeRow('f1', 'note.md'));
		await sqlite.exports.whenReady;

		files.update('f1', { trashedAt: Date.now() });

		await eventually(async () => {
			const paths = await mirroredPaths(sqlite);
			expect(paths.has('f1')).toBe(true);
			expect(paths.get('f1')).toBeNull();
		});

		await teardown();
	});

	test('renaming a folder converges descendant paths that never changed', async () => {
		const { files, sqlite, teardown } = setup();
		files.set(makeRow('d1', 'old', null, 'folder'));
		files.set(makeRow('d2', 'sub', 'd1', 'folder'));
		files.set(makeRow('f1', 'deep.md', 'd2'));
		await sqlite.exports.whenReady;

		files.update('d1', { name: 'new' });

		await eventually(async () => {
			const paths = await mirroredPaths(sqlite);
			expect(paths.get('d1')).toBe('/new');
			expect(paths.get('d2')).toBe('/new/sub');
			expect(paths.get('f1')).toBe('/new/sub/deep.md');
		});

		await teardown();
	});

	test('trashing a duplicate converges the surviving sibling path', async () => {
		const { files, sqlite, teardown } = setup();
		files.set({ ...makeRow('a', 'foo.txt'), createdAt: 1000 });
		files.set({ ...makeRow('b', 'foo.txt'), createdAt: 2000 });
		await sqlite.exports.whenReady;

		files.update('a', { trashedAt: Date.now() });

		await eventually(async () => {
			const paths = await mirroredPaths(sqlite);
			expect(paths.get('a')).toBeNull();
			expect(paths.get('b')).toBe('/foo.txt');
		});

		await teardown();
	});

	test('hard-deleted rows are removed from the mirror', async () => {
		const { files, sqlite, teardown } = setup();
		files.set(makeRow('f1', 'doomed.md'));
		await sqlite.exports.whenReady;

		files.delete('f1');

		await eventually(async () => {
			const paths = await mirroredPaths(sqlite);
			expect(paths.has('f1')).toBe(false);
		});

		await teardown();
	});

	test('search returns index paths usable for filesystem reads', async () => {
		const { files, sqlite, teardown } = setup();
		files.set({ ...makeRow('a', 'meeting.md'), createdAt: 1000 });
		files.set({ ...makeRow('b', 'meeting.md'), createdAt: 2000 });
		await sqlite.exports.whenReady;

		const results = await sqlite.exports.search('meeting');
		const paths = results.map((r) => r.path).sort();
		expect(paths).toEqual(['/meeting (1).md', '/meeting.md']);

		await teardown();
	});
});
