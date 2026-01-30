import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { defineExports } from '../core/lifecycle.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

describe('defineWorkspace', () => {
	test('creates workspace with tables and kv', () => {
		const workspace = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
			kv: {
				theme: defineKv()
					.version(type({ mode: "'light' | 'dark'" }))
					.migrate((v) => v),
			},
		});

		expect(workspace.id).toBe('test-app');
		expect(workspace.tableDefinitions).toHaveProperty('posts');
		expect(workspace.kvDefinitions).toHaveProperty('theme');
	});

	test('createWorkspace() returns client with tables and kv', () => {
		const workspace = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
			kv: {
				theme: defineKv()
					.version(type({ mode: "'light' | 'dark'" }))
					.migrate((v) => v),
			},
		});

		const client = createWorkspace(workspace);

		expect(client.id).toBe('test-app');
		expect(client.ydoc).toBeInstanceOf(Y.Doc);
		expect(client.tables.posts).toBeDefined();
		expect(client.kv.get).toBeDefined();
	});

	test('client.tables and client.kv work correctly', () => {
		const workspace = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
			kv: {
				theme: defineKv()
					.version(type({ mode: "'light' | 'dark'" }))
					.migrate((v) => v),
			},
		});

		const client = createWorkspace(workspace);

		// Use tables
		client.tables.posts.set({ id: '1', title: 'Hello' });
		const postResult = client.tables.posts.get('1');
		expect(postResult.status).toBe('valid');

		// Use KV
		client.kv.set('theme', { mode: 'dark' });
		const themeResult = client.kv.get('theme');
		expect(themeResult.status).toBe('valid');
	});

	test('createWorkspace().withExtensions() with capabilities', () => {
		const workspace = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
		});

		// Mock capability with custom exports - uses defineExports for lifecycle
		const mockCapability = (_context: {
			ydoc: Y.Doc;
			tables: unknown;
			kv: unknown;
		}) =>
			defineExports({
				customMethod: () => 'hello',
			});

		const client = createWorkspace(workspace).withExtensions({
			mock: mockCapability,
		});

		expect(client.capabilities.mock).toBeDefined();
		expect(client.capabilities.mock.customMethod()).toBe('hello');
	});

	test('capability exports are fully typed', () => {
		const workspace = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
		});

		// Capability with rich exports - defineExports fills in whenSynced/destroy
		const persistenceCapability = () =>
			defineExports({
				db: {
					query: (sql: string) => sql.toUpperCase(),
					execute: (sql: string) => ({ rows: [sql] }),
				},
				stats: { writes: 0, reads: 0 },
			});

		// Another capability with different exports
		const syncCapability = () =>
			defineExports({
				connect: (url: string) => `connected to ${url}`,
				disconnect: () => 'disconnected',
				status: 'idle' as 'idle' | 'syncing' | 'synced',
			});

		const client = createWorkspace(workspace).withExtensions({
			persistence: persistenceCapability,
			sync: syncCapability,
		});

		// Test persistence capability exports are typed
		const queryResult = client.capabilities.persistence.db.query('SELECT');
		expect(queryResult).toBe('SELECT');

		const execResult = client.capabilities.persistence.db.execute('INSERT');
		expect(execResult.rows).toEqual(['INSERT']);

		expect(client.capabilities.persistence.stats.writes).toBe(0);

		// Test sync capability exports are typed
		const connectResult = client.capabilities.sync.connect('ws://localhost');
		expect(connectResult).toBe('connected to ws://localhost');

		expect(client.capabilities.sync.disconnect()).toBe('disconnected');
		expect(client.capabilities.sync.status).toBe('idle');

		// Type assertions (these would fail to compile if types were wrong)
		const _queryType: string = queryResult;
		const _connectType: string = connectResult;
		const _statusType: 'idle' | 'syncing' | 'synced' =
			client.capabilities.sync.status;
		void _queryType;
		void _connectType;
		void _statusType;
	});

	test('client.destroy() cleans up', async () => {
		const workspace = defineWorkspace({
			id: 'test-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
		});

		let destroyed = false;
		const mockCapability = () =>
			defineExports({
				destroy: async () => {
					destroyed = true;
				},
			});

		const client = createWorkspace(workspace).withExtensions({
			mock: mockCapability,
		});

		await client.destroy();
		expect(destroyed).toBe(true);
	});

	test('workspace with empty tables and kv', () => {
		const workspace = defineWorkspace({
			id: 'empty-app',
		});

		const client = createWorkspace(workspace);

		expect(client.id).toBe('empty-app');
		expect(Object.keys(client.tables)).toHaveLength(0);
		// KV always has methods (get, set, delete, observe), but no keys are defined
		expect(client.kv.get).toBeDefined();
	});

	test('createWorkspace with direct config (without defineWorkspace)', () => {
		const client = createWorkspace({
			id: 'direct-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
		});

		expect(client.id).toBe('direct-app');
		expect(client.tables.posts).toBeDefined();

		client.tables.posts.set({ id: '1', title: 'Direct' });
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
	});

	test('createWorkspace client is usable before withExtensions', () => {
		const client = createWorkspace({
			id: 'builder-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
		});

		client.tables.posts.set({ id: '1', title: 'Before Extensions' });
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		expect(typeof client.withExtensions).toBe('function');
	});

	test('withExtensions shares same ydoc', () => {
		const baseClient = createWorkspace({
			id: 'shared-doc-app',
			tables: {
				posts: defineTable()
					.version(type({ id: 'string', title: 'string' }))
					.migrate((row) => row),
			},
		});

		baseClient.tables.posts.set({ id: '1', title: 'Original' });
		const clientWithExt = baseClient.withExtensions({});

		expect(clientWithExt.ydoc).toBe(baseClient.ydoc);

		const result = clientWithExt.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Original');
		}
	});
});
