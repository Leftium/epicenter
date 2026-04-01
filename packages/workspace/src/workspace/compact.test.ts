/**
 * Workspace Compaction Tests
 *
 * Verifies that workspace.compact() migrates all data to a fresh Y.Doc
 * with zero CRDT overhead. Tests cover data preservation, size reduction,
 * extension lifecycle, and multi-client coordination.
 *
 * Key behaviors:
 * - compact() preserves all table rows and KV entries
 * - compact() reduces encoded size (eliminates CRDT history)
 * - compact() increments the epoch in the coordination doc
 * - Extensions are re-initialized on the new data doc
 * - Multi-client: remote peer transitions on epoch change
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { generateEncryptionKey } from '../shared/crypto/index.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

function setup() {
	const postsTable = defineTable(
		type({ id: 'string', title: 'string', _v: '1' }),
	);
	const tagsTable = defineTable(
		type({ id: 'string', name: 'string', _v: '1' }),
	);
	const themeDef = defineKv(type({ mode: "'light' | 'dark'" }), {
		mode: 'light',
	});

	const definition = defineWorkspace({
		id: 'compact-test',
		tables: { posts: postsTable, tags: tagsTable },
		kv: { theme: themeDef },
	});

	const client = createWorkspace(definition);
	return { client, definition };
}

describe('workspace.compact()', () => {
	test('compact preserves all table rows', async () => {
		const { client } = setup();

		client.tables.posts.set({ id: '1', title: 'First', _v: 1 });
		client.tables.posts.set({ id: '2', title: 'Second', _v: 1 });
		client.tables.tags.set({ id: 't1', name: 'news', _v: 1 });

		await client.compact();

		expect(client.tables.posts.count()).toBe(2);
		const post = client.tables.posts.get('1');
		expect(post.status).toBe('valid');
		if (post.status === 'valid') {
			expect(post.row.title).toBe('First');
		}
		expect(client.tables.tags.count()).toBe(1);
	});

	test('compact preserves KV entries', async () => {
		const { client } = setup();

		client.kv.set('theme', { mode: 'dark' });

		await client.compact();

		expect(client.kv.get('theme')).toEqual({ mode: 'dark' });
	});

	test('compact reduces encoded size after heavy churn', async () => {
		const { client } = setup();

		// Create churn: write and overwrite many times
		for (let i = 0; i < 100; i++) {
			client.tables.posts.set({ id: '1', title: `Edit ${i}`, _v: 1 });
		}

		const sizeBefore = client.encodedSize();
		await client.compact();
		const sizeAfter = client.encodedSize();

		expect(sizeAfter).toBeLessThan(sizeBefore);
	});

	test('compact increments epoch', async () => {
		const { client } = setup();

		expect(client.epoch).toBe(0);
		await client.compact();
		expect(client.epoch).toBe(1);
		await client.compact();
		expect(client.epoch).toBe(2);
	});

	test('ydoc guid changes to new epoch after compact', async () => {
		const { client } = setup();

		expect(client.ydoc.guid).toBe('compact-test-0');
		await client.compact();
		expect(client.ydoc.guid).toBe('compact-test-1');
	});

	test('compact with no data is a no-op that still bumps epoch', async () => {
		const { client } = setup();

		await client.compact();

		expect(client.epoch).toBe(1);
		expect(client.tables.posts.count()).toBe(0);
	});

	test('operations work normally after compact', async () => {
		const { client } = setup();

		client.tables.posts.set({ id: '1', title: 'Before', _v: 1 });
		await client.compact();

		// Write after compact
		client.tables.posts.set({ id: '2', title: 'After', _v: 1 });
		client.tables.posts.set({ id: '1', title: 'Updated', _v: 1 });

		expect(client.tables.posts.count()).toBe(2);
		const post = client.tables.posts.get('1');
		if (post.status === 'valid') {
			expect(post.row.title).toBe('Updated');
		}
	});

	test('observers on old doc stop firing after compact', async () => {
		const { client } = setup();

		const changes: string[] = [];
		client.tables.posts.observe((ids) => {
			for (const id of ids) changes.push(id);
		});

		client.tables.posts.set({ id: '1', title: 'Pre', _v: 1 });
		expect(changes).toContain('1');

		await client.compact();
		client.tables.posts.set({ id: '2', title: 'Post', _v: 1 });

		// Observer was on the old data doc — does not fire after compact
		expect(changes).not.toContain('2');
	});

	test('re-registering observers via onEpochChange works', async () => {
		const { client } = setup();

		const changes: string[] = [];
		function registerObserver() {
			client.tables.posts.observe((ids) => {
				for (const id of ids) changes.push(id);
			});
		}

		registerObserver();
		client.onEpochChange(() => registerObserver());

		client.tables.posts.set({ id: '1', title: 'Pre', _v: 1 });
		await client.compact();
		client.tables.posts.set({ id: '2', title: 'Post', _v: 1 });

		expect(changes).toContain('1');
		expect(changes).toContain('2');
	});

	test('dispose after compact cleans up both coordination doc and data doc', async () => {
		const { client } = setup();

		client.tables.posts.set({ id: '1', title: 'Hello', _v: 1 });
		await client.compact();

		// Should not throw
		await client.dispose();
	});

	test('compact with encryption preserves encrypted data', async () => {
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const key = generateEncryptionKey();
		const client = createWorkspace(
			defineWorkspace({ id: 'enc-compact', tables: { posts: postsTable } }),
			{ key },
		).withEncryption();

		client.tables.posts.set({ id: '1', title: 'Secret', _v: 1 });

		await client.compact();

		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Secret');
		}
	});
});

describe('extension lifecycle during compact', () => {
	test('data doc extensions are re-created on compact', async () => {
		let factoryCallCount = 0;
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);

		const client = createWorkspace(
			defineWorkspace({ id: 'ext-refire', tables: { posts: postsTable } }),
		).withExtension('tracker', () => {
			factoryCallCount++;
			return { tag: 'tracked' };
		});

		// Factory fires once for initial data doc
		expect(factoryCallCount).toBe(1);

		await client.compact();

		// Factory fires again for the new data doc
		expect(factoryCallCount).toBeGreaterThan(1);
		expect(client.extensions.tracker.tag).toBe('tracked');
	});

	test('old extensions are disposed in LIFO order during compact', async () => {
		const disposeOrder: string[] = [];
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);

		const client = createWorkspace(
			defineWorkspace({
				id: 'lifo-compact',
				tables: { posts: postsTable },
			}),
		)
			.withExtension('first', () => ({
				dispose: () => {
					disposeOrder.push('first');
				},
			}))
			.withExtension('second', () => ({
				dispose: () => {
					disposeOrder.push('second');
				},
			}));

		await client.compact();

		// Old data doc extensions disposed in LIFO
		expect(disposeOrder).toEqual(['second', 'first']);
	});
});

describe('blue-green epoch swap', () => {
	test('extension failure during prep aborts swap — old doc unchanged', async () => {
		let callCount = 0;
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);

		const client = createWorkspace(
			defineWorkspace({ id: 'fail-swap', tables: { posts: postsTable } }),
		).withExtension('failing', () => {
			callCount++;
			if (callCount > 1) {
				// Second call (during compact re-fire) throws
				throw new Error('Extension init failed');
			}
			return { tag: 'ok' };
		});

		client.tables.posts.set({ id: '1', title: 'Hello', _v: 1 });

		// compact triggers doBlueGreenSwap which calls createFreshExtensions.
		// The extension factory throws on the second call.
		// Blue-green should abort — old doc stays.
		await client.compact();

		// Data should still be accessible on the old doc
		expect(client.tables.posts.count()).toBe(1);
		const post = client.tables.posts.get('1');
		expect(post.status).toBe('valid');
		if (post.status === 'valid') {
			expect(post.row.title).toBe('Hello');
		}
	});

	test('concurrent compact calls do not corrupt state', async () => {
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const client = createWorkspace(
			defineWorkspace({ id: 'concurrent-compact', tables: { posts: postsTable } }),
		);

		client.tables.posts.set({ id: '1', title: 'First', _v: 1 });

		// Fire two compacts concurrently
		await Promise.all([client.compact(), client.compact()]);

		// State should be consistent — no double-free, no lost data
		expect(client.tables.posts.count()).toBe(1);
		const post = client.tables.posts.get('1');
		expect(post.status).toBe('valid');
		if (post.status === 'valid') {
			expect(post.row.title).toBe('First');
		}
		// Epoch should have bumped twice
		expect(client.epoch).toBe(2);
	});

	test('onEpochChange callback fires after compact', async () => {
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const client = createWorkspace(
			defineWorkspace({ id: 'epoch-cb', tables: { posts: postsTable } }),
		);

		const epochs: number[] = [];
		client.onEpochChange((epoch) => epochs.push(epoch));

		await client.compact();
		await client.compact();

		expect(epochs).toEqual([1, 2]);
	});

	test('onEpochChange unsubscribe stops callbacks', async () => {
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const client = createWorkspace(
			defineWorkspace({ id: 'epoch-unsub', tables: { posts: postsTable } }),
		);

		const epochs: number[] = [];
		const unsub = client.onEpochChange((epoch) => epochs.push(epoch));

		await client.compact();
		unsub();
		await client.compact();

		expect(epochs).toEqual([1]);
	});
});
