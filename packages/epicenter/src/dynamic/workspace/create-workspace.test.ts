import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { defineExports } from '../../core/lifecycle';
import { boolean, id, Id, integer, select, table, text } from '../../core/schema';
import { defineWorkspace } from '../../core/schema/workspace-definition';
import { createHeadDoc } from '../head-doc';
import { createWorkspace } from './create-workspace';

// ════════════════════════════════════════════════════════════════════════════
// TEST FIXTURES
// ════════════════════════════════════════════════════════════════════════════

const postsTable = table({
	id: 'posts',
	name: 'Posts',
	fields: [
		id(),
		text({ id: 'title' }),
		integer({ id: 'view_count' }),
		boolean({ id: 'published' }),
	] as const,
});

const settingsKv = select({
	id: 'theme',
	name: 'Theme',
	options: ['light', 'dark'] as const,
	default: 'light',
});

const testDefinition = defineWorkspace({
	id: 'test-workspace',
	name: 'Test Workspace',
	description: 'A test workspace',
	icon: null,
	tables: [postsTable],
	kv: [settingsKv],
});

/**
 * Create a test HeadDoc with in-memory providers.
 */
function createTestHeadDoc(workspaceId: string) {
	return createHeadDoc({
		workspaceId,
		providers: {},
	});
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('createWorkspace', () => {
	describe('direct usage (no extensions)', () => {
		test('returns a usable client immediately', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			// Should be usable immediately
			expect(workspace.workspaceId).toBe('test-workspace');
			expect(workspace.epoch).toBe(0);
			expect(workspace.ydoc).toBeInstanceOf(Y.Doc);
			expect(workspace.tables).toBeDefined();
			expect(workspace.kv).toBeDefined();
			expect(workspace.extensions).toEqual({});
			expect(workspace.whenSynced).toBeInstanceOf(Promise);
			expect(typeof workspace.destroy).toBe('function');
		});

		test('tables are usable without extensions', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			// Insert a row (using type assertion due to pre-existing type inference limitations)
			workspace.tables.get('posts').upsert({
				id: '1',
				title: 'Hello World',
				view_count: 0,
				published: false,
			} as any);

			// Read back
			const result = workspace.tables.get('posts').get(Id('1'));
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect((result.row as any).title).toBe('Hello World');
				expect((result.row as any).view_count).toBe(0);
				expect((result.row as any).published).toBe(false);
			}
		});

		test('kv is usable without extensions', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			// Set a KV value
			workspace.kv.set('theme', 'dark');

			// Read back
			const result = workspace.kv.get('theme');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('dark');
			}
		});

		test('whenSynced resolves immediately without extensions', async () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			// Should resolve immediately since there are no extensions
			await expect(workspace.whenSynced).resolves.toBeUndefined();
		});
	});

	describe('.withExtensions()', () => {
		test('returns a new client with extensions', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const baseWorkspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			// Use inline factory for better type inference
			const workspace = baseWorkspace.withExtensions({
				mock: ({ workspaceId }) =>
					defineExports({
						greeting: `Hello from ${workspaceId}`,
					}),
			});

			// Should have extension exports
			expect(workspace.extensions.mock).toBeDefined();
			expect(workspace.extensions.mock.greeting).toBe(
				'Hello from test-workspace',
			);
		});

		test('extensions receive correct context', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const baseWorkspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			let receivedContext: Record<string, unknown> | undefined;
			baseWorkspace.withExtensions({
				capture: (ctx) => {
					receivedContext = {
						workspaceId: ctx.workspaceId,
						epoch: ctx.epoch,
						extensionId: ctx.extensionId,
						hasYdoc: ctx.ydoc instanceof Y.Doc,
						hasTables: typeof ctx.tables.get === 'function',
						hasKv: typeof ctx.kv.get === 'function',
					};
					return defineExports();
				},
			});

			expect(receivedContext).toBeDefined();
			expect(receivedContext?.workspaceId).toBe('test-workspace');
			expect(receivedContext?.epoch).toBe(0);
			expect(receivedContext?.extensionId).toBe('capture');
			expect(receivedContext?.hasYdoc).toBe(true);
			expect(receivedContext?.hasTables).toBe(true);
			expect(receivedContext?.hasKv).toBe(true);
		});

		test('whenSynced aggregates all extension promises', async () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const baseWorkspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			let resolved1 = false;
			let resolved2 = false;

			const workspace = baseWorkspace.withExtensions({
				ext1: () =>
					defineExports({
						whenSynced: new Promise<void>((resolve) => {
							setTimeout(() => {
								resolved1 = true;
								resolve();
							}, 10);
						}),
					}),
				ext2: () =>
					defineExports({
						whenSynced: new Promise<void>((resolve) => {
							setTimeout(() => {
								resolved2 = true;
								resolve();
							}, 20);
						}),
					}),
			});

			// Before awaiting, neither should be resolved
			expect(resolved1).toBe(false);
			expect(resolved2).toBe(false);

			// After awaiting, both should be resolved
			await workspace.whenSynced;
			expect(resolved1).toBe(true);
			expect(resolved2).toBe(true);
		});

		test('base client extensions remains empty after chaining', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const baseWorkspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			const chainedWorkspace = baseWorkspace.withExtensions({
				mock: () => defineExports({ data: 'test' }),
			});

			// Base should still have empty extensions
			expect(baseWorkspace.extensions).toEqual({});
			// Chained should have the extension
			expect(chainedWorkspace.extensions.mock.data).toBe('test');
		});
	});

	describe('lifecycle', () => {
		test('destroy() cleans up Y.Doc', async () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			// Add some data (using type assertion due to pre-existing type inference limitations)
			workspace.tables.get('posts').upsert({
				id: '1',
				title: 'Test',
				view_count: 0,
				published: false,
			} as any);

			// Destroy
			await workspace.destroy();

			// Y.Doc should be destroyed (no way to directly check, but shouldn't throw)
		});

		test('destroy() calls extension destroy functions', async () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const baseWorkspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			let destroyed1 = false;
			let destroyed2 = false;

			const workspace = baseWorkspace.withExtensions({
				ext1: () =>
					defineExports({
						destroy: () => {
							destroyed1 = true;
						},
					}),
				ext2: () =>
					defineExports({
						destroy: () => {
							destroyed2 = true;
						},
					}),
			});

			// Before destroy
			expect(destroyed1).toBe(false);
			expect(destroyed2).toBe(false);

			// After destroy
			await workspace.destroy();
			expect(destroyed1).toBe(true);
			expect(destroyed2).toBe(true);
		});

		test('Symbol.asyncDispose works for await using', async () => {
			const headDoc = createTestHeadDoc('test-workspace');
			let destroyed = false;

			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				tracker: () =>
					defineExports({
						destroy: () => {
							destroyed = true;
						},
					}),
			});

			// Manually call asyncDispose (simulate await using)
			await workspace[Symbol.asyncDispose]();

			expect(destroyed).toBe(true);
		});
	});

	describe('HeadDoc integration', () => {
		test('extracts workspaceId from headDoc', () => {
			const headDoc = createTestHeadDoc('my-workspace-id');
			const workspace = createWorkspace({
				headDoc,
				definition: defineWorkspace({
					id: 'my-workspace-id',
					name: 'My Workspace',
					description: '',
					icon: null,
					tables: [],
					kv: [],
				}),
			});

			expect(workspace.workspaceId).toBe('my-workspace-id');
		});

		test('extracts epoch from headDoc.getOwnEpoch()', () => {
			const headDoc = createTestHeadDoc('test-workspace');

			// Bump epoch on headDoc
			headDoc.bumpEpoch();
			headDoc.bumpEpoch();

			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			expect(workspace.epoch).toBe(2);
		});

		test('Y.Doc guid is {workspaceId}-{epoch}', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			headDoc.bumpEpoch(); // epoch = 1

			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			expect(workspace.ydoc.guid).toBe('test-workspace-1');
		});
	});

	describe('type inference', () => {
		test('table types work at runtime', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			});

			// Insert data (using type assertion due to pre-existing type inference limitations)
			workspace.tables.get('posts').upsert({
				id: '1',
				title: 'Test',
				view_count: 100,
				published: true,
			} as any);

			const result = workspace.tables.get('posts').get(Id('1'));
			if (result.status === 'valid') {
				// Verify values at runtime
				expect((result.row as any).title).toBe('Test');
				expect((result.row as any).view_count).toBe(100);
				expect((result.row as any).published).toBe(true);
			}
		});

		test('extension types are inferred correctly', () => {
			const headDoc = createTestHeadDoc('test-workspace');
			const workspace = createWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				myExt: () =>
					defineExports({
						version: 1,
						getName: () => 'my-extension',
					}),
			});

			// These should be correctly typed via inference
			expect(workspace.extensions.myExt.version).toBe(1);
			expect(workspace.extensions.myExt.getName()).toBe('my-extension');
		});
	});
});
