import { describe, expect, test } from 'bun:test';
import type { Lifecycle } from '@epicenter/hq';
import type { ProviderFactory } from '@epicenter/hq/dynamic';
import * as Y from 'yjs';
import { createContentDocStore } from './content-doc-store.js';
import type { FileId } from './types.js';

const fid = (s: string) => s as FileId;

describe('createContentDocStore', () => {
	test('ensure creates a new Y.Doc', async () => {
		const store = createContentDocStore();
		const ydoc = await store.ensure(fid('file-1'));

		expect(ydoc).toBeInstanceOf(Y.Doc);
		expect(ydoc.guid).toBe('file-1');
		expect(ydoc.gc).toBe(false);

		await store.destroyAll();
	});

	test('ensure is idempotent — returns same Y.Doc', async () => {
		const store = createContentDocStore();
		const d1 = await store.ensure(fid('file-1'));
		const d2 = await store.ensure(fid('file-1'));

		expect(d1).toBe(d2);

		await store.destroyAll();
	});

	test('ensure returns different docs for different ids', async () => {
		const store = createContentDocStore();
		const d1 = await store.ensure(fid('file-1'));
		const d2 = await store.ensure(fid('file-2'));

		expect(d1).not.toBe(d2);
		expect(d1.guid).toBe('file-1');
		expect(d2.guid).toBe('file-2');

		await store.destroyAll();
	});

	test('destroy removes a specific doc', async () => {
		const store = createContentDocStore();
		const d1 = await store.ensure(fid('file-1'));
		await store.ensure(fid('file-2'));

		await store.destroy(fid('file-1'));

		// New ensure for file-1 should create a fresh doc
		const d1b = await store.ensure(fid('file-1'));
		expect(d1b).not.toBe(d1);
		expect(d1b.guid).toBe('file-1');

		await store.destroyAll();
	});

	test('destroy is a no-op for unknown id', async () => {
		const store = createContentDocStore();
		// Should not throw
		await store.destroy(fid('nonexistent'));
		await store.destroyAll();
	});

	test('destroyAll clears all docs', async () => {
		const store = createContentDocStore();
		const d1 = await store.ensure(fid('file-1'));
		const d2 = await store.ensure(fid('file-2'));

		await store.destroyAll();

		// New ensures should create fresh docs
		const d1b = await store.ensure(fid('file-1'));
		const d2b = await store.ensure(fid('file-2'));
		expect(d1b).not.toBe(d1);
		expect(d2b).not.toBe(d2);

		await store.destroyAll();
	});
});

describe('with providers', () => {
	test('ensure runs provider factories and awaits whenReady', async () => {
		let factoryCallCount = 0;
		const { promise: whenReady, resolve } = Promise.withResolvers<void>();

		const mockProvider: ProviderFactory = () => {
			factoryCallCount++;
			return { whenReady, destroy: () => {} } satisfies Lifecycle;
		};

		const store = createContentDocStore([mockProvider]);
		const ensurePromise = store.ensure(fid('file-1'));

		// Factory called synchronously
		expect(factoryCallCount).toBe(1);

		// Not yet resolved
		let resolved = false;
		ensurePromise.then(() => {
			resolved = true;
		});
		await Promise.resolve(); // flush microtasks
		expect(resolved).toBe(false);

		// Resolve sync
		resolve();
		const ydoc = await ensurePromise;
		expect(ydoc).toBeInstanceOf(Y.Doc);
		expect(ydoc.guid).toBe('file-1');

		await store.destroyAll();
	});

	test('concurrent ensure calls are deduplicated', async () => {
		let factoryCallCount = 0;
		const mockProvider: ProviderFactory = () => {
			factoryCallCount++;
			return {
				whenReady: Promise.resolve(),
				destroy: () => {},
			} satisfies Lifecycle;
		};

		const store = createContentDocStore([mockProvider]);
		const [d1, d2] = await Promise.all([
			store.ensure(fid('file-1')),
			store.ensure(fid('file-1')),
		]);

		expect(d1).toBe(d2);
		expect(factoryCallCount).toBe(1);

		await store.destroyAll();
	});

	test('destroy calls provider destroy', async () => {
		let destroyed = false;
		const mockProvider: ProviderFactory = () => {
			return {
				whenReady: Promise.resolve(),
				destroy: () => {
					destroyed = true;
				},
			} satisfies Lifecycle;
		};

		const store = createContentDocStore([mockProvider]);
		await store.ensure(fid('file-1'));

		await store.destroy(fid('file-1'));
		expect(destroyed).toBe(true);
	});

	test('destroyAll calls all provider destroys', async () => {
		const destroyCalls: string[] = [];
		const mockProvider: ProviderFactory = ({ ydoc }) => {
			return {
				whenReady: Promise.resolve(),
				destroy: () => {
					destroyCalls.push(ydoc.guid);
				},
			} satisfies Lifecycle;
		};

		const store = createContentDocStore([mockProvider]);
		await store.ensure(fid('file-1'));
		await store.ensure(fid('file-2'));

		await store.destroyAll();
		expect(destroyCalls).toContain('file-1');
		expect(destroyCalls).toContain('file-2');
	});

	test('factory error cleans up partially-created providers', () => {
		let firstDestroyed = false;
		const goodProvider: ProviderFactory = () => {
			return {
				whenReady: Promise.resolve(),
				destroy: () => {
					firstDestroyed = true;
				},
			} satisfies Lifecycle;
		};
		const badProvider: ProviderFactory = () => {
			throw new Error('factory failed');
		};

		const store = createContentDocStore([goodProvider, badProvider]);
		// Factory throws synchronously before returning a promise
		expect(() => store.ensure(fid('file-1'))).toThrow('factory failed');
		expect(firstDestroyed).toBe(true);
	});
});
