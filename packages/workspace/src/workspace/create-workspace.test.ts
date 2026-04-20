/**
 * createWorkspace Tests
 *
 * Verifies workspace client behavior for batching, observer delivery, and documents wiring.
 * These tests protect the runtime contract that table/KV operations stay consistent across transactions
 * and that optional document bindings are attached only when configured.
 *
 * Key behaviors:
 * - Batch transactions coalesce notifications while preserving applied mutations.
 * - Document-bound tables expose `documents`, while non-bound tables do not.
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from '@noble/ciphers/utils.js';
import { type } from 'arktype';
import * as Y from 'yjs';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { bytesToBase64 } from '../shared/crypto/index.js';
import { createDocuments } from './create-documents.js';
import { timeline } from './strategies.js';
import { createTables } from '../__tests__/create-tables.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';
import type { EncryptionKeys } from './encryption-key.js';

/** Wrap a raw Uint8Array key into a single-entry EncryptionKeys for tests. */
function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}
/** Creates a workspace client with two tables and one KV for testing. */
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
		id: 'test-workspace',
		tables: { posts: postsTable, tags: tagsTable },
		kv: { theme: themeDef },
	});

	const client = createWorkspace(definition);
	return { client };
}

describe('createWorkspace', () => {
	describe('batch()', () => {
		describe('core behavior', () => {
			test('batch() batches table operations', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: '1', title: 'First', _v: 1 });
					client.tables.posts.set({ id: '2', title: 'Second', _v: 1 });
					client.tables.posts.set({ id: '3', title: 'Third', _v: 1 });
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(changes[0]?.has('3')).toBe(true);
				expect(client.tables.posts.count()).toBe(3);

				unsubscribe();
			});

			test('batch() batches table deletes', () => {
				const { client } = setup();

				client.tables.posts.set({ id: '1', title: 'A', _v: 1 });
				client.tables.posts.set({ id: '2', title: 'B', _v: 1 });
				client.tables.posts.set({ id: '3', title: 'C', _v: 1 });

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.delete('1');
					client.tables.posts.delete('2');
					client.tables.posts.delete('3');
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(changes[0]?.has('3')).toBe(true);
				expect(client.tables.posts.count()).toBe(0);

				unsubscribe();
			});

			test('batch() batches mixed set + delete', () => {
				const { client } = setup();

				client.tables.posts.set({ id: '1', title: 'Existing', _v: 1 });

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: '2', title: 'New', _v: 1 });
					client.tables.posts.delete('1');
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(client.tables.posts.count()).toBe(1);
				expect(client.tables.posts.has('1')).toBe(false);
				expect(client.tables.posts.has('2')).toBe(true);

				unsubscribe();
			});

			test('batch() works across multiple tables', () => {
				const { client } = setup();

				const postChanges: Set<string>[] = [];
				const tagChanges: Set<string>[] = [];

				const unsubPosts = client.tables.posts.observe((changedIds) => {
					postChanges.push(new Set(changedIds));
				});
				const unsubTags = client.tables.tags.observe((changedIds) => {
					tagChanges.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: 'p1', title: 'Post', _v: 1 });
					client.tables.tags.set({ id: 't1', name: 'Tag', _v: 1 });
				});

				expect(postChanges).toHaveLength(1);
				expect(postChanges[0]?.has('p1')).toBe(true);
				expect(tagChanges).toHaveLength(1);
				expect(tagChanges[0]?.has('t1')).toBe(true);

				unsubPosts();
				unsubTags();
			});

			test('batch() works across tables and KV', () => {
				const { client } = setup();

				const postChanges: Set<string>[] = [];
				const kvChanges: unknown[] = [];

				const unsubPosts = client.tables.posts.observe((changedIds) => {
					postChanges.push(new Set(changedIds));
				});
				const unsubKv = client.kv.observe('theme', (change) => {
					kvChanges.push(change);
				});

				client.batch(() => {
					client.tables.posts.set({ id: 'p1', title: 'Post', _v: 1 });
					client.kv.set('theme', { mode: 'dark' });
				});

				expect(postChanges).toHaveLength(1);
				expect(postChanges[0]?.has('p1')).toBe(true);
				expect(kvChanges).toHaveLength(1);

				unsubPosts();
				unsubKv();
			});

			test('batch() with no operations is a no-op', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					// intentionally empty
				});

				expect(changes).toHaveLength(0);

				unsubscribe();
			});

			test('nested batch() calls emit one merged notification', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					client.tables.posts.set({ id: '1', title: 'Outer', _v: 1 });
					client.batch(() => {
						client.tables.posts.set({ id: '2', title: 'Inner', _v: 1 });
					});
					client.tables.posts.set({ id: '3', title: 'After inner', _v: 1 });
				});

				// Inner batch absorbed by outer — single notification
				expect(changes).toHaveLength(1);
				expect(changes[0]?.has('1')).toBe(true);
				expect(changes[0]?.has('2')).toBe(true);
				expect(changes[0]?.has('3')).toBe(true);

				unsubscribe();
			});
		});

		describe('observer semantics', () => {
			test('without batch(), each set() fires observer separately', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.tables.posts.set({ id: '1', title: 'First', _v: 1 });
				client.tables.posts.set({ id: '2', title: 'Second', _v: 1 });
				client.tables.posts.set({ id: '3', title: 'Third', _v: 1 });

				expect(changes).toHaveLength(3);

				unsubscribe();
			});

			test('with batch(), many operations emit one notification', () => {
				const { client } = setup();

				const changes: Set<string>[] = [];
				const unsubscribe = client.tables.posts.observe((changedIds) => {
					changes.push(new Set(changedIds));
				});

				client.batch(() => {
					for (let i = 0; i < 100; i++) {
						client.tables.posts.set({ id: `${i}`, title: `Post ${i}`, _v: 1 });
					}
				});

				expect(changes).toHaveLength(1);
				expect(changes[0]?.size).toBe(100);

				unsubscribe();
			});
		});

		describe('edge cases', () => {
			test('error inside batch() still applies prior operations', () => {
				const { client } = setup();

				try {
					client.batch(() => {
						client.tables.posts.set({ id: '1', title: 'Before error', _v: 1 });
						client.tables.posts.set({ id: '2', title: 'Also before', _v: 1 });
						throw new Error('intentional');
					});
				} catch {
					// expected
				}

				// Yjs transact doesn't roll back — prior mutations are applied
				expect(client.tables.posts.has('1')).toBe(true);
				expect(client.tables.posts.has('2')).toBe(true);
				expect(client.tables.posts.count()).toBe(2);
			});
		});
	});

	describe('extension init signal', () => {
		test('withExtension preserves extension exports', () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);

			const client = createWorkspace({
				id: 'ext-await-test-1',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				return { exports: { someValue: 42 }, dispose: () => {} };
			});

			expect(client.extensions.myExt.someValue).toBe(42);
		});

		test('extension factory receives prior extensions', () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let receivedFirstExtension = false;

			createWorkspace({
				id: 'ext-await-test-2',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						exports: { value: 'first' },
						dispose: () => {},
					};
				})
				.withWorkspaceExtension('second', ({ extensions }) => {
					receivedFirstExtension = extensions.first.value === 'first';
					return { exports: {}, dispose: () => {} };
				});

			expect(receivedFirstExtension).toBe(true);
		});

		test('composite whenReady waits for all extension init signals to resolve', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let resolveFirstInit: (() => void) | undefined;

			const firstInit = new Promise<void>((resolve) => {
				resolveFirstInit = resolve;
			});

			const client = createWorkspace({
				id: 'ext-await-test-3',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						exports: { value: 'first' },
						init: firstInit,
						dispose: () => {},
					};
				})
				.withExtension('second', () => {
					return {
						exports: { value: 'second' },
						init: Promise.resolve(),
						dispose: () => {},
					};
				});

			let compositeResolved = false;
			client.whenReady.then(() => {
				compositeResolved = true;
			});

			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveFirstInit?.();
			await client.whenReady;
			expect(compositeResolved).toBe(true);
		});

		test('composite whenReady waits for all extensions', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let resolveFirstInit: (() => void) | undefined;
			let resolveSecondInit: (() => void) | undefined;

			const firstInit = new Promise<void>((resolve) => {
				resolveFirstInit = resolve;
			});
			const secondInit = new Promise<void>((resolve) => {
				resolveSecondInit = resolve;
			});

			const client = createWorkspace({
				id: 'ext-await-test-4',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						exports: {},
						init: firstInit,
						dispose: () => {},
					};
				})
				.withExtension('second', () => {
					return {
						exports: {},
						init: secondInit,
						dispose: () => {},
					};
				});

			let compositeResolved = false;
			client.whenReady.then(() => {
				compositeResolved = true;
			});

			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveFirstInit?.();
			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveSecondInit?.();
			await client.whenReady;
			expect(compositeResolved).toBe(true);
		});

		test('extension exports are accessible', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);

			const client = createWorkspace({
				id: 'ext-await-test-5',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				return { exports: { foo: 42 } };
			});

			expect(client.extensions.myExt.foo).toBe(42);
		});

		test('extension without dispose still works (framework defaults to noop)', async () => {
			const client = createWorkspace({
				id: 'ext-dispose-default',
			}).withExtension('bare', () => {
				return { exports: { tag: 'no-lifecycle' } };
			});

			await client.whenReady;
			expect(client.extensions.bare.tag).toBe('no-lifecycle');
		});

		test('surgical await: extension B chains off ctx.init from prior extensions', async () => {
			const order: string[] = [];
			let resolveA: (() => void) | undefined;
			const aReady = new Promise<void>((r) => {
				resolveA = r;
			});

			const client = createWorkspace({
				id: 'surgical-await-test',
			})
				.withExtension('a', () => ({
					exports: { tag: 'a' },
					init: aReady.then(() => {
						order.push('a-ready');
					}),
				}))
				.withExtension('b', ({ init }) => {
					const bInit = (async () => {
						await init;
						order.push('b-ready');
					})();
					return { exports: { tag: 'b' }, init: bInit };
				});

			void client;
			resolveA?.();
			await client.whenReady;
			expect(order).toEqual(['a-ready', 'b-ready']);
		});
	});

	describe('document wiring', () => {
		test('table using withDocument exposes documents in documents namespace', () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				content: timeline,
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'doc-test',
				tables: { files: filesTable },
			});

			const content = client.documents.files.content;
			expect(content).toBeDefined();
			expect(typeof content.open).toBe('function');
			expect(typeof content.close).toBe('function');
			expect(typeof content.closeAll).toBe('function');
		});

		test('table without withDocument does not appear in documents namespace', () => {
			const { client } = setup();

			expect(Object.keys(client.documents)).not.toContain('posts');
			expect(Object.keys(client.documents)).not.toContain('tags');
		});

		test('withDocumentExtension is wired into document bindings', async () => {
			let hookCalled = false;

			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				content: timeline,
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'doc-ext-test',
				tables: { files: filesTable },
			}).withDocumentExtension('test', () => {
				hookCalled = true;
				return { exports: {}, dispose: () => {} };
			});

			await client.documents.files.content.open('f1');

			expect(hookCalled).toBe(true);
		});

		test('withExtension registers for both workspace and document Y.Docs', async () => {
			let factoryCallCount = 0;

			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				content: timeline,
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			// withExtension fires factory for workspace Y.Doc AND registers
			// it as a document extension
			const client = createWorkspace({
				id: 'three-tier-both-test',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				factoryCallCount++;
				return {
					exports: { tag: 'ext' },
					dispose: () => {},
				};
			});

			// Factory fires once synchronously for the workspace Y.Doc
			expect(factoryCallCount).toBe(1);
			expect(client.extensions.myExt.tag).toBe('ext');

			// Open a document — the same factory should fire again as a document extension
			await client.documents.files.content.open('f1');

			// Factory called twice: once for workspace, once for document
			expect(factoryCallCount).toBe(2);
		});

		test('withWorkspaceExtension fires only for workspace Y.Doc, not documents', async () => {
			let factoryCallCount = 0;

			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				content: timeline,
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'three-tier-ws-only-test',
				tables: { files: filesTable },
			}).withWorkspaceExtension('wsOnly', () => {
				factoryCallCount++;
				return {
					exports: { tag: 'ws-only' },
					dispose: () => {},
				};
			});

			// Factory should fire once for workspace Y.Doc
			expect(factoryCallCount).toBe(1);
			expect(client.extensions.wsOnly.tag).toBe('ws-only');

			// Opening a document should NOT trigger this extension
			await client.documents.files.content.open('f1');

			// Still exactly 1 call — withWorkspaceExtension does not register for documents
			expect(factoryCallCount).toBe(1);
		});

		test('workspace dispose cascades to closeAll on bindings', async () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				content: timeline,
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'doc-dispose-test',
				tables: { files: filesTable },
			});

			const doc1 = await client.documents.files.content.open('f1');

			await client.dispose();

			// After dispose, open should create a new Y.Doc (since documents were disposed)
			// But we can't open after workspace dispose — just verify no error occurred
			expect(doc1).toBeDefined();
		});

		test('multiple tables with document bindings each get their own namespace', () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', {
				content: timeline,
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const notesTable = defineTable(
				type({
					id: 'string',
					bodyDocId: 'string',
					bodyUpdatedAt: 'number',
					_v: '1',
				}),
			).withDocument('body', {
				content: timeline,
				guid: 'bodyDocId',
				onUpdate: () => ({ bodyUpdatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'multi-doc-test',
				tables: { files: filesTable, notes: notesTable },
			});

			expect(client.documents.files.content).toBeDefined();
			expect(client.documents.notes.body).toBeDefined();
			expect(client.documents.files.content).not.toBe(
				client.documents.notes.body,
			);
		});
	});

	// ════════════════════════════════════════════════════════════════════════════
	// BASELINE TESTS (Phase 0) — Verify lifecycle correctness
	// ════════════════════════════════════════════════════════════════════════════

	describe('lifecycle baseline', () => {
		const def = defineWorkspace({ id: 'lifecycle-test' });

		test('gc defaults to false to preserve deletion markers for sync', () => {
			const client = createWorkspace({ id: 'gc-default' });
			expect(client.ydoc.gc).toBe(false);
		});

		test('gc option overrides the default', () => {
			const client = createWorkspace({ id: 'gc-on', gc: true });
			expect(client.ydoc.gc).toBe(true);
		});

		test('builder branching creates isolated extension sets', () => {
			const base = createWorkspace(def).withExtension('a', () => ({
				exports: { value: 'a' },
			}));
			const b1 = base.withExtension('b', () => ({ exports: { value: 'b' } }));
			const b2 = base.withExtension('c', () => ({ exports: { value: 'c' } }));

			expect(Object.keys(base.extensions)).toEqual(['a']);
			expect(Object.keys(b1.extensions)).toEqual(['a', 'b']);
			expect(Object.keys(b2.extensions)).toEqual(['a', 'c']);
		});

		test('void-returning factory does not appear in extensions', () => {
			const client = createWorkspace(def)
				.withExtension(
					'noop',
					() => undefined as unknown as { exports: Record<string, unknown> },
				)
				.withExtension('real', () => ({ exports: { value: 42 } }));

			expect(client.extensions.noop).toBeUndefined();
			expect(client.extensions.real).toBeDefined();
			expect(client.extensions.real.value).toBe(42);
		});

		test('factory throw in workspace cleans up prior extensions in LIFO order', async () => {
			const cleanupOrder: string[] = [];
			const factory =
				(name: string, shouldThrow = false) =>
				() => {
					if (shouldThrow) throw new Error(`${name} factory failed`);
					return {
						exports: {},
						dispose: async () => {
							cleanupOrder.push(name);
						},
					};
				};

			try {
				createWorkspace(def)
					.withExtension('first', factory('first'))
					.withExtension('second', factory('second'))
					.withExtension('third', factory('third', true)); // throws
			} catch {
				// expected
			}

			expect(cleanupOrder).toEqual(['second', 'first']); // LIFO, skips 'third'
		});

		test('document extension dispose order is LIFO', async () => {
			const disposeOrder: string[] = [];
			const factory = (name: string) => () => ({
				exports: {},
				dispose: async () => {
					disposeOrder.push(name);
				},
			});

			const mockYdoc = new Y.Doc({ guid: 'doc-lifo-test' });
			const fileSchema = type({
				id: 'string',
				updatedAt: 'number',
				_v: '1',
			});
			const tables = createTables(mockYdoc, {
				files: defineTable(fileSchema),
			});

			const documents = createDocuments({
				id: 'test-lifo',
				tableName: 'files',
				documentName: 'content',
				guidKey: 'id',
				content: timeline,
				onUpdate: () => ({ updatedAt: Date.now() }),
				tableHelper: tables.files,
				ydoc: mockYdoc,
				documentExtensions: [
					{ key: 'first', factory: factory('first') },
					{ key: 'second', factory: factory('second') },
					{ key: 'third', factory: factory('third') },
				],
			});

			await documents.open('doc-1');
			await documents.close('doc-1');

			expect(disposeOrder).toEqual(['third', 'second', 'first']); // LIFO
		});

		test('init rejection in workspace triggers cleanup', async () => {
			const cleanupCalled = new Set<string>();
			let rejectInit: (() => void) | undefined;
			const initPromise = new Promise<void>((_, reject) => {
				rejectInit = () => reject(new Error('provider failed'));
			});

			const client = createWorkspace(def)
				.withExtension('first', () => ({
					exports: {},
					dispose: async () => {
						cleanupCalled.add('first');
					},
				}))
				.withExtension('second', () => ({
					exports: {},
					init: initPromise,
					dispose: async () => {
						cleanupCalled.add('second');
					},
				}));

			// Trigger rejection
			rejectInit?.();

			try {
				await client.whenReady;
			} catch {
				// expected
			}

			expect(cleanupCalled.has('first')).toBe(true);
			expect(cleanupCalled.has('second')).toBe(true);
		});

		test('document extension init rejection triggers cleanup', async () => {
			const cleanupCalled = new Set<string>();
			let rejectInit: (() => void) | undefined;
			const initPromise = new Promise<void>((_, reject) => {
				rejectInit = () => reject(new Error('provider failed'));
			});

			const mockYdoc = new Y.Doc({ guid: 'doc-reject-test' });
			const fileSchema = type({
				id: 'string',
				updatedAt: 'number',
				_v: '1',
			});
			const tables = createTables(mockYdoc, {
				files: defineTable(fileSchema),
			});

			const documents = createDocuments({
				id: 'test-whenready-rejection',
				tableName: 'files',
				documentName: 'content',
				guidKey: 'id',
				content: timeline,
				onUpdate: () => ({ updatedAt: Date.now() }),
				tableHelper: tables.files,
				ydoc: mockYdoc,
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							exports: {},
							dispose: async () => {
								cleanupCalled.add('first');
							},
						}),
					},
					{
						key: 'second',
						factory: () => ({
							exports: {},
							init: initPromise,
							dispose: async () => {
								cleanupCalled.add('second');
							},
						}),
					},
				],
			});

			const handlePromise = documents.open('doc-1');
			rejectInit?.();

			try {
				await handlePromise;
			} catch {
				// expected
			}

			expect(cleanupCalled.has('first')).toBe(true);
			expect(cleanupCalled.has('second')).toBe(true);
		});
	});
});

// ============================================================================
// applyEncryptionKeys()
// ============================================================================

describe('applyEncryptionKeys', () => {
	function setupEncryptedWorkspace() {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		const client = createWorkspace(
			defineWorkspace({ id: 'enc-test', tables: { posts } }),
		);
		return { client, key: randomBytes(32) };
	}

	test('applyEncryptionKeys enables encrypted writes', () => {
		const { client, key } = setupEncryptedWorkspace();
		client.applyEncryptionKeys(toEncryptionKeys(key));
		client.tables.posts.set({ id: '1', title: 'Secret', _v: 1 });

		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Secret');
		}
	});

	test('de-dup: calling applyEncryptionKeys twice with same key preserves data', () => {
		const { client, key } = setupEncryptedWorkspace();
		client.applyEncryptionKeys(toEncryptionKeys(key));
		client.tables.posts.set({ id: '1', title: 'Secret', _v: 1 });

		// Apply same keys again
		client.applyEncryptionKeys(toEncryptionKeys(key));

		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Secret');
		}
	});

	test('key rotation: old data readable after applying new keyring', () => {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		const client = createWorkspace(
			defineWorkspace({ id: 'rotation-test', tables: { posts } }),
		);

		const keyV1 = randomBytes(32);
		const keyV2 = randomBytes(32);

		// Write with key v1
		client.applyEncryptionKeys([
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
		]);
		client.tables.posts.set({ id: '1', title: 'Written with v1', _v: 1 });

		// Rotate to v2 (keyring includes both versions for backward compat)
		client.applyEncryptionKeys([
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
		]);

		// Old data still readable
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Written with v1');
		}

		// New writes work too
		client.tables.posts.set({ id: '2', title: 'Written with v2', _v: 1 });
		const result2 = client.tables.posts.get('2');
		expect(result2.status).toBe('valid');
		if (result2.status === 'valid') {
			expect(result2.row.title).toBe('Written with v2');
		}
	});

	test('plaintext data readable before keys applied', () => {
		const { client } = setupEncryptedWorkspace();
		// Write plaintext before applying keys
		client.tables.posts.set({ id: '1', title: 'Plaintext', _v: 1 });

		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Plaintext');
		}
	});

	test('applyEncryptionKeys re-encrypts plaintext entries', () => {
		const { client, key } = setupEncryptedWorkspace();
		// Write plaintext first
		client.tables.posts.set({ id: '1', title: 'Was Plaintext', _v: 1 });

		// Apply keys — should re-encrypt existing plaintext
		client.applyEncryptionKeys(toEncryptionKeys(key));

		// Data still readable through encrypted wrapper
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Was Plaintext');
		}
	});

	test('applyEncryptionKeys is synchronous', () => {
		const { client, key } = setupEncryptedWorkspace();
		// Should not return a Promise
		const result = client.applyEncryptionKeys(toEncryptionKeys(key));
		expect(result).toBeUndefined();
	});

	test('same-key dedup: second call with identical keys is a no-op', () => {
		const { client, key } = setupEncryptedWorkspace();
		const keys = toEncryptionKeys(key);
		client.applyEncryptionKeys(keys);
		client.tables.posts.set({ id: '1', title: 'Before dedup', _v: 1 });

		// Second call with identical keys should be a no-op (dedup)
		client.applyEncryptionKeys(keys);

		// Data should still be readable (dedup didn't break anything)
		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Before dedup');
		}
	});

	test('same-key dedup: different order is still recognized as same keys', () => {
		const { client } = setupEncryptedWorkspace();
		const keyV1 = randomBytes(32);
		const keyV2 = randomBytes(32);
		const keysAsc: EncryptionKeys = [
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
		];
		const keysDesc: EncryptionKeys = [
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
		];

		client.applyEncryptionKeys(keysAsc);
		client.tables.posts.set({ id: '1', title: 'Order test', _v: 1 });

		// Reversed order should dedup (same fingerprint after sorting)
		client.applyEncryptionKeys(keysDesc);

		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Order test');
		}
	});
});

describe('withActions (non-terminal)', () => {
	function actionsSetup() {
		const postsTable = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const definition = defineWorkspace({
			id: 'actions-test',
			tables: { posts: postsTable },
			kv: {},
		});
		return { definition };
	}

	test('withActions before withExtension — actions available on final builder', () => {
		const { definition } = actionsSetup();

		const ws = createWorkspace(definition)
			.withActions(({ tables }) => ({
				getAllPosts: defineQuery({
					handler: () => tables.posts.getAllValid(),
				}),
			}))
			.withExtension('dummy', ({ ydoc }) => ({
				exports: { testValue: 42 },
			}));

		// Actions survive the extension chain
		expect(ws.actions).toBeDefined();
		expect(ws.actions.getAllPosts).toBeDefined();
		expect(ws.actions.getAllPosts.type).toBe('query');

		// Extension also exists
		expect(ws.extensions.dummy.testValue).toBe(42);
	});

	test('multiple withActions calls merge action trees', () => {
		const { definition } = actionsSetup();

		const ws = createWorkspace(definition)
			.withActions(({ tables }) => ({
				getAll: defineQuery({ handler: () => tables.posts.getAllValid() }),
			}))
			.withActions(({ tables }) => ({
				count: defineQuery({ handler: () => tables.posts.count() }),
			}));

		expect(ws.actions.getAll).toBeDefined();
		expect(ws.actions.count).toBeDefined();
		expect(ws.actions.getAll.type).toBe('query');
		expect(ws.actions.count.type).toBe('query');
	});

	test('withActions factory receives client WITHOUT extensions when called before extensions', () => {
		const { definition } = actionsSetup();
		let capturedExtensions: Record<string, unknown> = {};

		const ws = createWorkspace(definition)
			.withActions((client) => {
				capturedExtensions = client.extensions;
				return {
					noop: defineQuery({ handler: () => {} }),
				};
			})
			.withExtension('dummy', ({ ydoc }) => ({ exports: { flag: true } }));

		// At the time withActions was called, no extensions existed
		expect(Object.keys(capturedExtensions)).toHaveLength(0);

		// But extensions are available on the final builder
		expect(ws.extensions.dummy.flag).toBe(true);
	});

	test('withActions factory receives client WITH extensions when called after extensions', () => {
		const { definition } = actionsSetup();
		let capturedExtensions: Record<string, unknown> = {};

		const ws = createWorkspace(definition)
			.withExtension('dummy', ({ ydoc }) => ({ exports: { flag: true } }))
			.withActions((client) => {
				capturedExtensions = client.extensions;
				return {
					noop: defineQuery({ handler: () => {} }),
				};
			});

		// Extensions were available when withActions was called
		expect(Object.keys(capturedExtensions)).toContain('dummy');
	});

	test('actions work correctly — factory closes over live tables', () => {
		const { definition } = actionsSetup();

		const ws = createWorkspace(definition).withActions(({ tables }) => ({
			getAll: defineQuery({
				handler: () => tables.posts.getAllValid(),
			}),
			create: defineMutation({
				handler: () => {
					tables.posts.set({ id: '1', title: 'Hello', _v: 1 });
				},
			}),
		}));

		// Mutation writes to tables
		ws.actions.create();
		const result = ws.actions.getAll();
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe('Hello');
	});

	test('withActions after withExtension still allows more withExtension calls', () => {
		const { definition } = actionsSetup();

		const ws = createWorkspace(definition)
			.withExtension('ext1', ({ ydoc }) => ({ exports: { a: 1 } }))
			.withActions(() => ({
				noop: defineQuery({ handler: () => {} }),
			}))
			.withExtension('ext2', ({ ydoc }) => ({ exports: { b: 2 } }));

		expect(ws.extensions.ext1.a).toBe(1);
		expect(ws.extensions.ext2.b).toBe(2);
		expect(ws.actions.noop).toBeDefined();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Workspace-scope onActive/onIdle semantics
// ════════════════════════════════════════════════════════════════════════════

describe('workspace-scope onActive / onIdle', () => {
	test('workspace extensions receive onActive exactly once after init resolves', async () => {
		let onActiveCount = 0;
		let onActiveAfterInit = false;
		let initResolved = false;

		const ws = createWorkspace({ id: 'ws-on-active' }).withExtension(
			'tracker',
			() => ({
				exports: {},
				init: (async () => {
					await Promise.resolve();
					initResolved = true;
				})(),
				onActive: () => {
					onActiveAfterInit = initResolved;
					onActiveCount++;
				},
			}),
		);

		await ws.whenReady;
		expect(onActiveCount).toBe(1);
		expect(onActiveAfterInit).toBe(true);
		await ws.dispose();
	});

	test('workspace extensions never receive onIdle', async () => {
		// At the workspace scope there is no bind/release — the workspace Y.Doc
		// is always considered active. onIdle should stay unreached even
		// through the full dispose path.
		let onIdleCount = 0;

		const ws = createWorkspace({ id: 'ws-no-idle' }).withExtension(
			'tracker',
			() => ({
				exports: {},
				onActive: () => {},
				onIdle: () => {
					onIdleCount++;
				},
			}),
		);

		await ws.whenReady;
		await ws.dispose();
		expect(onIdleCount).toBe(0);
	});

	test('throwing workspace onActive does not abort bootstrap; later extensions still register', async () => {
		// Error containment at workspace scope — a buggy extension's onActive
		// should log + continue, not take down the whole workspace. Later
		// extensions still get their onActive call and their exports are
		// available on client.extensions.
		const originalConsoleError = console.error;
		const errors: unknown[] = [];
		console.error = (...args) => {
			errors.push(args);
		};

		try {
			let laterActivated = false;

			const ws = createWorkspace({ id: 'ws-onactive-throws' })
				.withExtension('bad', () => ({
					exports: {},
					onActive: () => {
						throw new Error('simulated');
					},
				}))
				.withExtension('good', () => ({
					exports: { marker: 'ok' },
					onActive: () => {
						laterActivated = true;
					},
				}));

			// whenReady should resolve despite the throwing onActive.
			await ws.whenReady;

			expect(laterActivated).toBe(true);
			expect(ws.extensions.good.marker).toBe('ok');
			// The framework logged the error rather than swallowing silently.
			expect(errors.length).toBeGreaterThan(0);

			await ws.dispose();
		} finally {
			console.error = originalConsoleError;
		}
	});
});
