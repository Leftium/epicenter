import { describe, expect, test } from 'bun:test';
import { createWorkspace } from '../static/create-workspace.js';
import type { TableHelper } from '../static/types.js';
import { createFileSystemIndex } from './file-system-index.js';
import { filesTable } from './file-table.js';
import type { FileId, FileRow } from './types.js';

const fid = (s: string) => s as FileId;

function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	// Arktype schema uses plain strings; cast to branded FileRow for filesystem functions
	const files = ws.tables.files as unknown as TableHelper<FileRow>;
	return { files };
}

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

describe('createFileSystemIndex', () => {
	test('empty table — no paths or children', () => {
		const { files } = setup();
		const index = createFileSystemIndex(files);

		expect(index.pathToId.size).toBe(0);
		expect(index.childrenOf.size).toBe(0);

		index.destroy();
	});

	test('single file at root', () => {
		const { files } = setup();
		files.set(makeRow('f1', 'hello.txt'));
		const index = createFileSystemIndex(files);

		expect(index.pathToId.get('/hello.txt')).toBe(fid('f1'));
		expect(index.childrenOf.get(null)).toContain(fid('f1'));

		index.destroy();
	});

	test('nested directory structure', () => {
		const { files } = setup();
		files.set(makeRow('d1', 'docs', null, 'folder'));
		files.set(makeRow('f1', 'api.md', 'd1'));
		files.set(makeRow('f2', 'readme.md', 'd1'));
		const index = createFileSystemIndex(files);

		expect(index.pathToId.get('/docs')).toBe(fid('d1'));
		expect(index.pathToId.get('/docs/api.md')).toBe(fid('f1'));
		expect(index.pathToId.get('/docs/readme.md')).toBe(fid('f2'));
		expect(index.childrenOf.get(fid('d1'))).toEqual(
			expect.arrayContaining([fid('f1'), fid('f2')]),
		);

		index.destroy();
	});

	test('deeply nested path', () => {
		const { files } = setup();
		files.set(makeRow('d1', 'a', null, 'folder'));
		files.set(makeRow('d2', 'b', 'd1', 'folder'));
		files.set(makeRow('d3', 'c', 'd2', 'folder'));
		files.set(makeRow('f1', 'file.txt', 'd3'));
		const index = createFileSystemIndex(files);

		expect(index.pathToId.get('/a/b/c/file.txt')).toBe(fid('f1'));

		index.destroy();
	});

	test('trashed files are excluded', () => {
		const { files } = setup();
		files.set(makeRow('f1', 'active.txt'));
		files.set({ ...makeRow('f2', 'trashed.txt'), trashedAt: Date.now() });
		const index = createFileSystemIndex(files);

		expect(index.pathToId.get('/active.txt')).toBe(fid('f1'));
		expect(index.pathToId.has('/trashed.txt')).toBe(false);

		index.destroy();
	});

	test('reactive update — adding a file updates index', () => {
		const { files } = setup();
		const index = createFileSystemIndex(files);

		expect(index.pathToId.has('/new.txt')).toBe(false);

		files.set(makeRow('f1', 'new.txt'));

		// observe() fires synchronously in Yjs
		expect(index.pathToId.get('/new.txt')).toBe(fid('f1'));

		index.destroy();
	});

	test('reactive update — trashing a file removes from index', () => {
		const { files } = setup();
		files.set(makeRow('f1', 'hello.txt'));
		const index = createFileSystemIndex(files);

		expect(index.pathToId.get('/hello.txt')).toBe(fid('f1'));

		files.update('f1', { trashedAt: Date.now() });

		expect(index.pathToId.has('/hello.txt')).toBe(false);

		index.destroy();
	});

	test('reactive update — rename updates path', () => {
		const { files } = setup();
		files.set(makeRow('f1', 'old.txt'));
		const index = createFileSystemIndex(files);

		expect(index.pathToId.get('/old.txt')).toBe(fid('f1'));

		files.update('f1', { name: 'new.txt' });

		expect(index.pathToId.has('/old.txt')).toBe(false);
		expect(index.pathToId.get('/new.txt')).toBe(fid('f1'));

		index.destroy();
	});

	test('orphan detection — orphaned file moved to root', () => {
		const { files } = setup();
		// Create file with parentId referencing non-existent folder
		files.set(makeRow('f1', 'orphan.txt', 'nonexistent'));
		const index = createFileSystemIndex(files);

		// File should be moved to root
		const result = files.get('f1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.parentId).toBeNull();
		}
		expect(index.pathToId.get('/orphan.txt')).toBe(fid('f1'));

		index.destroy();
	});

	test('CRDT duplicate names are disambiguated', () => {
		const { files } = setup();
		files.set({ ...makeRow('a', 'foo.txt'), createdAt: 1000, updatedAt: 1000 });
		files.set({ ...makeRow('b', 'foo.txt'), createdAt: 2000, updatedAt: 2000 });
		const index = createFileSystemIndex(files);

		// Earliest keeps clean name, later gets suffix
		expect(index.pathToId.get('/foo.txt')).toBe(fid('a'));
		expect(index.pathToId.get('/foo (1).txt')).toBe(fid('b'));

		index.destroy();
	});
});
