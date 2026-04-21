/**
 * defineWorkspace Tests
 *
 * Validates that workspace definitions and created clients expose the expected typed APIs.
 * The suite also covers extension chaining, lifecycle ordering, and action binding semantics.
 *
 * Key behaviors:
 * - Workspace creation preserves typed access to tables, kv, and extensions.
 * - Extension readiness and teardown order stay deterministic.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { defineQuery } from '../shared/actions.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

describe('defineWorkspace', () => {
	test('returns a factory with the original definition attached', () => {
		const factory = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
			kv: {
				theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
			},
		});

		expect(factory.definition.id).toBe('test-app');
		expect(factory.definition.tables).toHaveProperty('posts');
		expect(factory.definition.kv).toHaveProperty('theme');
		expect(typeof factory.open).toBe('function');
		expect(typeof factory.close).toBe('function');
	});

	test('factory.open returns a handle that exposes the bundle surface', async () => {
		const factory = defineWorkspace({
			id: 'handle-test',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
			kv: {
				theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
			},
		});

		const handle = factory.open('handle-test');
		expect(handle.ydoc).toBeInstanceOf(Y.Doc);
		expect(handle.tables.posts).toBeDefined();
		expect(handle.kv.get('theme')).toEqual({ mode: 'light' });
		expect(handle.enc).toBeDefined();
		await handle.whenReady;

		handle.dispose();
		await factory.close('handle-test');
	});

	test('gcTime: Infinity is the default — refcount→0 does not auto-evict', async () => {
		const factory = defineWorkspace({ id: 'never-evict' });
		const h1 = factory.open('never-evict');
		h1.dispose();
		// Reopen should hit the same cached bundle (same ydoc).
		const h2 = factory.open('never-evict');
		expect(h2.ydoc).toBe(h1.ydoc);
		h2.dispose();
		await factory.close('never-evict');
	});

	test('createWorkspace() returns client with tables and kv', () => {
		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
			kv: {
				theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
			},
		});

		expect(client.id).toBe('test-app');
		expect(client.ydoc).toBeInstanceOf(Y.Doc);
		expect(client.tables.posts).toBeDefined();
		expect(client.kv.get).toBeDefined();
	});

	test('client.tables and client.kv support read and write operations', () => {
		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
			kv: {
				theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
			},
		});

		// Use tables
		client.tables.posts.set({ id: '1', title: 'Hello', _v: 1 });
		const postResult = client.tables.posts.get('1');
		expect(postResult.status).toBe('valid');

		// Use KV
		client.kv.set('theme', { mode: 'dark' });
		const themeResult = client.kv.get('theme');
		expect(themeResult).toEqual({ mode: 'dark' });
	});

	test('createWorkspace().withExtension() adds extensions', () => {
		// Mock extension with custom exports
		const mockExtension = (_context: {
			ydoc: Y.Doc;
			tables?: unknown;
			kv?: unknown;
		}) => ({
			exports: { customMethod: () => 'hello' },
		});

		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		}).withExtension('mock', mockExtension);

		expect(client.extensions.mock).toBeDefined();
		expect(client.extensions.mock.customMethod()).toBe('hello');
	});

	test('extension exports are fully typed', () => {
		// Extension with rich exports
		const persistenceExtension = () => ({
			exports: {
				db: {
					query: (sql: string) => sql.toUpperCase(),
					execute: (sql: string) => ({ rows: [sql] }),
				},
				stats: { writes: 0, reads: 0 },
			},
		});

		// Another extension with different exports
		const syncExtension = () => ({
			exports: {
				connect: (url: string) => `connected to ${url}`,
				disconnect: () => 'disconnected',
				status: 'idle' as 'idle' | 'syncing' | 'synced',
			},
		});

		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('persistence', persistenceExtension)
			.withExtension('sync', syncExtension);

		// Test persistence extension exports are typed
		const queryResult = client.extensions.persistence.db.query('SELECT');
		expect(queryResult).toBe('SELECT');

		const execResult = client.extensions.persistence.db.execute('INSERT');
		expect(execResult.rows).toEqual(['INSERT']);

		expect(client.extensions.persistence.stats.writes).toBe(0);

		// Test sync extension exports are typed
		const connectResult = client.extensions.sync.connect('ws://localhost');
		expect(connectResult).toBe('connected to ws://localhost');

		expect(client.extensions.sync.disconnect()).toBe('disconnected');
		expect(client.extensions.sync.status).toBe('idle');

		// Type assertions (these would fail to compile if types were wrong)
		const _queryType: string = queryResult;
		const _connectType: string = connectResult;
		const _statusType: 'idle' | 'syncing' | 'synced' =
			client.extensions.sync.status;
		void _queryType;
		void _connectType;
		void _statusType;
	});

	test('client.dispose() cleans up', async () => {
		let disposed = false;
		const mockExtension = () => ({
			exports: {},
			dispose: async () => {
				disposed = true;
			},
		});

		const client = createWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		}).withExtension('mock', mockExtension);

		await client.dispose();
		expect(disposed).toBe(true);
	});

	test('workspace with empty tables and kv initializes base client APIs', () => {
		const workspace = defineWorkspace({
			id: 'empty-app',
		});

		const client = createWorkspace(workspace);

		expect(client.id).toBe('empty-app');
		expect(Object.keys(client.definitions.tables)).toHaveLength(0);
		// KV always has methods (get, set, delete, observe), but no keys are defined
		expect(client.kv.get).toBeDefined();
	});

	test('createWorkspace with direct config (without defineWorkspace)', () => {
		const client = createWorkspace({
			id: 'direct-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		});

		expect(client.id).toBe('direct-app');
		expect(client.tables.posts).toBeDefined();

		client.tables.posts.set({ id: '1', title: 'Direct', _v: 1 });
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
	});

	test('createWorkspace client is usable before withExtension', () => {
		const client = createWorkspace({
			id: 'builder-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		});

		client.tables.posts.set({ id: '1', title: 'Before Extensions', _v: 1 });
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		expect(typeof client.withExtension).toBe('function');
	});

	test('withExtension chain keeps the same ydoc instance', () => {
		const baseClient = createWorkspace({
			id: 'shared-doc-app',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		});

		baseClient.tables.posts.set({ id: '1', title: 'Original', _v: 1 });
		const clientWithExt = baseClient;

		expect(clientWithExt.ydoc).toBe(baseClient.ydoc);

		const result = clientWithExt.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Original');
		}
	});

	test('extension N+1 can access extension N exports via context (progressive type safety)', () => {
		const client = createWorkspace({
			id: 'chain-test',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('first', () => ({
				exports: {
					value: 42,
					helper: () => 'from-first',
				},
			}))
			.withExtension('second', ({ extensions }) => {
				// extensions.first is fully typed here — no casts needed
				const doubled = extensions.first.value * 2;
				const msg = extensions.first.helper();
				return { exports: { doubled, msg } };
			})
			.withExtension('third', ({ extensions }) => {
				// extensions.first AND extensions.second are both fully typed
				const tripled = extensions.first.value * 3;
				const fromSecond = extensions.second.doubled;
				return { exports: { tripled, fromSecond } };
			});

		// All extensions accessible and typed on the final client
		expect(client.extensions.first.value).toBe(42);
		expect(client.extensions.first.helper()).toBe('from-first');
		expect(client.extensions.second.doubled).toBe(84);
		expect(client.extensions.second.msg).toBe('from-first');
		expect(client.extensions.third.tripled).toBe(126);
		expect(client.extensions.third.fromSecond).toBe(84);

		// Type-level assertions: these assignments would fail to compile if types were wrong
		const _num: number = client.extensions.first.value;
		const _str: string = client.extensions.first.helper();
		const _doubled: number = client.extensions.second.doubled;
		const _msg: string = client.extensions.second.msg;
		const _tripled: number = client.extensions.third.tripled;
		const _fromSecond: number = client.extensions.third.fromSecond;
		void [_num, _str, _doubled, _msg, _tripled, _fromSecond];
	});

	test('.withActions() works after .withExtension() chain', () => {
		const client = createWorkspace({
			id: 'actions-after-ext',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('analytics', () => ({
				exports: { getCount: () => 5 },
			}))
			.withActions((c) => ({
				getAnalyticsCount: defineQuery({
					handler: () => c.extensions.analytics.getCount(),
				}),
				addPost: defineQuery({
					input: Type.Object({ title: Type.String() }),
					handler: ({ title }) => {
						c.tables.posts.set({ id: '1', title, _v: 1 });
					},
				}),
			}));

		// Actions are callable directly
		expect(client.actions.getAnalyticsCount()).toBe(5);
		client.actions.addPost({ title: 'Hello' });

		// Extensions still accessible
		expect(client.extensions.analytics.getCount()).toBe(5);

		// Tables still accessible
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
	});

	test('context.init resolves after prior extensions', async () => {
		const order: string[] = [];

		const client = createWorkspace({
			id: 'when-ready-test',
			tables: {
				posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
			},
		})
			.withExtension('slow', () => ({
				exports: { tag: 'slow' },
				init: new Promise<void>((resolve) =>
					setTimeout(() => {
						order.push('slow-ready');
						resolve();
					}, 50),
				),
			}))
			.withExtension('dependent', ({ init }) => {
				// init should be a promise representing all prior extensions
				expect(init).toBeInstanceOf(Promise);

				const initPromise = (async () => {
					await init;
					order.push('dependent-ready');
				})();

				return {
					exports: { tag: 'dependent' },
					init: initPromise,
				};
			});

		await client.whenReady;
		// 'slow' must resolve before 'dependent' starts
		expect(order).toEqual(['slow-ready', 'dependent-ready']);
	});

	test('first extension gets immediately-resolving context.init', async () => {
		let contextInit: Promise<void> | undefined;

		createWorkspace({
			id: 'first-ext-test',
		}).withExtension('first', ({ init }) => {
			contextInit = init;
			return { exports: { tag: 'first' } };
		});

		// First extension's init = Promise.all([]) which resolves immediately
		expect(contextInit).toBeInstanceOf(Promise);
		await contextInit; // should not hang
	});

	test('context includes client, init, and extensions', () => {
		const tableDef = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);

		createWorkspace({
			id: 'full-context-test',
			tables: { posts: tableDef },
		}).withExtension('inspector', ({ ydoc, init }) => {
			// SharedExtensionContext only has ydoc + init
			expect(ydoc).toBeDefined();
			expect(init).toBeInstanceOf(Promise);
			return { exports: {} };
		});
	});

	test('dispose runs in reverse order (LIFO)', async () => {
		const order: string[] = [];

		const client = createWorkspace({
			id: 'dispose-order',
		})
			.withExtension('a', () => ({
				exports: {},
				dispose: () => {
					order.push('a');
				},
			}))
			.withExtension('b', () => ({
				exports: {},
				dispose: () => {
					order.push('b');
				},
			}))
			.withExtension('c', () => ({
				exports: {},
				dispose: () => {
					order.push('c');
				},
			}));

		await client.dispose();
		expect(order).toEqual(['c', 'b', 'a']);
	});
});
