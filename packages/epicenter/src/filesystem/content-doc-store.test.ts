import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { FileId } from './types.js';
import { createContentDocStore } from './content-doc-store.js';

const fid = (s: string) => s as FileId;

describe('createContentDocStore', () => {
	test('ensure creates a new Y.Doc', () => {
		const store = createContentDocStore();
		const ydoc = store.ensure(fid('file-1'));

		expect(ydoc).toBeInstanceOf(Y.Doc);
		expect(ydoc.guid).toBe('file-1');
		expect(ydoc.gc).toBe(false);

		store.destroyAll();
	});

	test('ensure is idempotent — returns same Y.Doc', () => {
		const store = createContentDocStore();
		const d1 = store.ensure(fid('file-1'));
		const d2 = store.ensure(fid('file-1'));

		expect(d1).toBe(d2);

		store.destroyAll();
	});

	test('ensure returns different docs for different ids', () => {
		const store = createContentDocStore();
		const d1 = store.ensure(fid('file-1'));
		const d2 = store.ensure(fid('file-2'));

		expect(d1).not.toBe(d2);
		expect(d1.guid).toBe('file-1');
		expect(d2.guid).toBe('file-2');

		store.destroyAll();
	});

	test('destroy removes a specific doc', () => {
		const store = createContentDocStore();
		const d1 = store.ensure(fid('file-1'));
		store.ensure(fid('file-2'));

		store.destroy(fid('file-1'));

		// New ensure for file-1 should create a fresh doc
		const d1b = store.ensure(fid('file-1'));
		expect(d1b).not.toBe(d1);
		expect(d1b.guid).toBe('file-1');

		store.destroyAll();
	});

	test('destroy is a no-op for unknown id', () => {
		const store = createContentDocStore();
		// Should not throw
		store.destroy(fid('nonexistent'));
		store.destroyAll();
	});

	test('destroyAll clears all docs', () => {
		const store = createContentDocStore();
		const d1 = store.ensure(fid('file-1'));
		const d2 = store.ensure(fid('file-2'));

		store.destroyAll();

		// New ensures should create fresh docs
		const d1b = store.ensure(fid('file-1'));
		const d2b = store.ensure(fid('file-2'));
		expect(d1b).not.toBe(d1);
		expect(d2b).not.toBe(d2);

		store.destroyAll();
	});
});
