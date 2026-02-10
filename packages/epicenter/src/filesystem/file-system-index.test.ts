import { describe, expect, test } from 'bun:test';
import { createWorkspace } from '../static/create-workspace.js';
import { filesTable } from './file-table.js';
import { createFileSystemIndex } from './file-system-index.js';
import { ROOT_ID } from './types.js';

function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	return ws;
}

function makeRow(id: string, name: string, parentId: string | null = null, type: 'file' | 'folder' = 'file') {
	return {
		id,
		name,
		parentId,
		type,
		size: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		trashedAt: null,
	};
}

describe('createFileSystemIndex', () => {
	test('empty table — root exists', () => {
		const ws = setup();
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.get('/')).toBe(ROOT_ID);
		expect(index.idToPath.get(ROOT_ID)).toBe('/');
		expect(index.childrenOf.size).toBe(0);

		index.destroy();
	});

	test('single file at root', () => {
		const ws = setup();
		ws.tables.files.set(makeRow('f1', 'hello.txt'));
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.get('/hello.txt')).toBe('f1');
		expect(index.idToPath.get('f1')).toBe('/hello.txt');
		expect(index.childrenOf.get(ROOT_ID)).toContain('f1');

		index.destroy();
	});

	test('nested directory structure', () => {
		const ws = setup();
		ws.tables.files.set(makeRow('d1', 'docs', null, 'folder'));
		ws.tables.files.set(makeRow('f1', 'api.md', 'd1'));
		ws.tables.files.set(makeRow('f2', 'readme.md', 'd1'));
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.get('/docs')).toBe('d1');
		expect(index.pathToId.get('/docs/api.md')).toBe('f1');
		expect(index.pathToId.get('/docs/readme.md')).toBe('f2');
		expect(index.childrenOf.get('d1')).toEqual(expect.arrayContaining(['f1', 'f2']));

		index.destroy();
	});

	test('deeply nested path', () => {
		const ws = setup();
		ws.tables.files.set(makeRow('d1', 'a', null, 'folder'));
		ws.tables.files.set(makeRow('d2', 'b', 'd1', 'folder'));
		ws.tables.files.set(makeRow('d3', 'c', 'd2', 'folder'));
		ws.tables.files.set(makeRow('f1', 'file.txt', 'd3'));
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.get('/a/b/c/file.txt')).toBe('f1');
		expect(index.idToPath.get('f1')).toBe('/a/b/c/file.txt');

		index.destroy();
	});

	test('trashed files are excluded', () => {
		const ws = setup();
		ws.tables.files.set(makeRow('f1', 'active.txt'));
		ws.tables.files.set({ ...makeRow('f2', 'trashed.txt'), trashedAt: Date.now() });
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.get('/active.txt')).toBe('f1');
		expect(index.pathToId.has('/trashed.txt')).toBe(false);

		index.destroy();
	});

	test('reactive update — adding a file updates index', () => {
		const ws = setup();
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.has('/new.txt')).toBe(false);

		ws.tables.files.set(makeRow('f1', 'new.txt'));

		// observe() fires synchronously in Yjs
		expect(index.pathToId.get('/new.txt')).toBe('f1');

		index.destroy();
	});

	test('reactive update — trashing a file removes from index', () => {
		const ws = setup();
		ws.tables.files.set(makeRow('f1', 'hello.txt'));
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.get('/hello.txt')).toBe('f1');

		ws.tables.files.update('f1', { trashedAt: Date.now() });

		expect(index.pathToId.has('/hello.txt')).toBe(false);

		index.destroy();
	});

	test('reactive update — rename updates path', () => {
		const ws = setup();
		ws.tables.files.set(makeRow('f1', 'old.txt'));
		const index = createFileSystemIndex(ws.tables.files);

		expect(index.pathToId.get('/old.txt')).toBe('f1');

		ws.tables.files.update('f1', { name: 'new.txt' });

		expect(index.pathToId.has('/old.txt')).toBe(false);
		expect(index.pathToId.get('/new.txt')).toBe('f1');

		index.destroy();
	});

	test('orphan detection — orphaned file moved to root', () => {
		const ws = setup();
		// Create file with parentId referencing non-existent folder
		ws.tables.files.set(makeRow('f1', 'orphan.txt', 'nonexistent'));
		const index = createFileSystemIndex(ws.tables.files);

		// File should be moved to root
		const result = ws.tables.files.get('f1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.parentId).toBeNull();
		}
		expect(index.pathToId.get('/orphan.txt')).toBe('f1');

		index.destroy();
	});

	test('CRDT duplicate names are disambiguated', () => {
		const ws = setup();
		ws.tables.files.set({ ...makeRow('a', 'foo.txt'), createdAt: 1000, updatedAt: 1000 });
		ws.tables.files.set({ ...makeRow('b', 'foo.txt'), createdAt: 2000, updatedAt: 2000 });
		const index = createFileSystemIndex(ws.tables.files);

		// Earliest keeps clean name, later gets suffix
		expect(index.pathToId.get('/foo.txt')).toBe('a');
		expect(index.pathToId.get('/foo (1).txt')).toBe('b');

		index.destroy();
	});

	test('plaintext cache survives metadata-only updates', () => {
		const ws = setup();
		ws.tables.files.set(makeRow('f1', 'hello.txt'));
		const index = createFileSystemIndex(ws.tables.files);

		// Manually populate plaintext cache
		index.plaintext.set('f1', 'cached content');

		// Metadata-only update should NOT invalidate plaintext cache
		ws.tables.files.update('f1', { updatedAt: Date.now() });

		expect(index.plaintext.has('f1')).toBe(true);
		expect(index.plaintext.get('f1')).toBe('cached content');

		index.destroy();
	});
});
