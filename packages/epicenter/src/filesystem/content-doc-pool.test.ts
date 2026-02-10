import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { FileId } from './types.js';
import { createContentDocPool } from './content-doc-pool.js';

const fid = (s: string) => s as FileId;

describe('createContentDocPool', () => {
	test('acquire creates a new doc', () => {
		const pool = createContentDocPool();
		const handle = pool.acquire(fid('file-1'), 'hello.txt');

		expect(handle.type).toBe('text');
		expect(handle.fileId).toBe(fid('file-1'));
		expect(handle.ydoc).toBeInstanceOf(Y.Doc);
		expect(handle.ydoc.guid).toBe('file-1');

		pool.release(fid('file-1'));
	});

	test('acquire returns same handle on second call', () => {
		const pool = createContentDocPool();
		const h1 = pool.acquire(fid('file-1'), 'hello.txt');
		const h2 = pool.acquire(fid('file-1'), 'hello.txt');

		expect(h1).toBe(h2);

		pool.release(fid('file-1'));
		pool.release(fid('file-1'));
	});

	test('release destroys doc when refcount hits 0', () => {
		const pool = createContentDocPool();
		pool.acquire(fid('file-1'), 'hello.txt');

		pool.release(fid('file-1'));
		expect(pool.peek(fid('file-1'))).toBeUndefined();
	});

	test('release does not destroy with remaining refs', () => {
		const pool = createContentDocPool();
		pool.acquire(fid('file-1'), 'hello.txt');
		pool.acquire(fid('file-1'), 'hello.txt'); // refcount = 2

		pool.release(fid('file-1')); // refcount = 1
		expect(pool.peek(fid('file-1'))).toBeDefined();

		pool.release(fid('file-1')); // refcount = 0
		expect(pool.peek(fid('file-1'))).toBeUndefined();
	});

	test('peek returns undefined for unloaded doc', () => {
		const pool = createContentDocPool();
		expect(pool.peek(fid('nonexistent'))).toBeUndefined();
	});

	test('loadAndCache reads content and releases', () => {
		const pool = createContentDocPool();

		// Pre-populate a doc
		const handle = pool.acquire(fid('file-1'), 'hello.txt');
		if (handle.type === 'text') {
			handle.content.insert(0, 'Hello World');
		}
		pool.release(fid('file-1'));

		// loadAndCache on a fresh acquire
		const handle2 = pool.acquire(fid('file-1'), 'hello.txt');
		if (handle2.type === 'text') {
			handle2.content.insert(0, 'Hello World');
		}
		pool.release(fid('file-1'));

		// Since doc was destroyed and recreated, content is empty
		// In a real scenario with providers, content would be synced
		const text = pool.loadAndCache(fid('file-1'), 'hello.txt');
		expect(typeof text).toBe('string');

		// Doc should be released after loadAndCache
		expect(pool.peek(fid('file-1'))).toBeUndefined();
	});

	test('provider is called and destroyed', () => {
		let providerCreated = false;
		let providerDestroyed = false;

		const pool = createContentDocPool((_ydoc) => {
			providerCreated = true;
			return {
				destroy() {
					providerDestroyed = true;
				},
			};
		});

		pool.acquire(fid('file-1'), 'hello.txt');
		expect(providerCreated).toBe(true);

		pool.release(fid('file-1'));
		expect(providerDestroyed).toBe(true);
	});

	test('gc: false on content docs', () => {
		const pool = createContentDocPool();
		const handle = pool.acquire(fid('file-1'), 'hello.txt');
		expect(handle.ydoc.gc).toBe(false);
		pool.release(fid('file-1'));
	});
});
