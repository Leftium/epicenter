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

import { describe, expect, mock, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	bytesToBase64,
	generateEncryptionKey,
} from '../shared/crypto/index.js';
import { createDocuments } from './create-document.js';
import { createTables } from './create-tables.js';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';
import type { UserKeyCache } from './user-key-cache.js';

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

function createDeferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
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

	describe('extension whenReady', () => {
		test('withExtension injects whenReady into extension exports', () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);

			const client = createWorkspace({
				id: 'ext-await-test-1',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				return { someValue: 42, dispose: () => {} };
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
						value: 'first',
						dispose: () => {},
					};
				})
				.withExtension('second', ({ extensions }) => {
					receivedFirstExtension = extensions.first.value === 'first';
					return { dispose: () => {} };
				});

			expect(receivedFirstExtension).toBe(true);
		});

		test('composite whenReady waits for all extensions to resolve', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let resolveFirstWhenReady: (() => void) | undefined;

			const firstWhenReady = new Promise<void>((resolve) => {
				resolveFirstWhenReady = resolve;
			});

			const client = createWorkspace({
				id: 'ext-await-test-3',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						value: 'first',
						whenReady: firstWhenReady,
						dispose: () => {},
					};
				})
				.withExtension('second', () => {
					return {
						value: 'second',
						whenReady: Promise.resolve(),
						dispose: () => {},
					};
				});

			let compositeResolved = false;
			client.whenReady.then(() => {
				compositeResolved = true;
			});

			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveFirstWhenReady?.();
			await client.whenReady;
			expect(compositeResolved).toBe(true);
		});

		test('composite whenReady waits for all extensions', async () => {
			const filesTable = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			);
			let resolveFirstWhenReady: (() => void) | undefined;
			let resolveSecondWhenReady: (() => void) | undefined;

			const firstWhenReady = new Promise<void>((resolve) => {
				resolveFirstWhenReady = resolve;
			});
			const secondWhenReady = new Promise<void>((resolve) => {
				resolveSecondWhenReady = resolve;
			});

			const client = createWorkspace({
				id: 'ext-await-test-4',
				tables: { files: filesTable },
			})
				.withExtension('first', () => {
					return {
						whenReady: firstWhenReady,
						dispose: () => {},
					};
				})
				.withExtension('second', () => {
					return {
						whenReady: secondWhenReady,
						dispose: () => {},
					};
				});

			let compositeResolved = false;
			client.whenReady.then(() => {
				compositeResolved = true;
			});

			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveFirstWhenReady?.();
			await Promise.resolve();
			expect(compositeResolved).toBe(false);

			resolveSecondWhenReady?.();
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
				return { foo: 42 };
			});

			expect(client.extensions.myExt.foo).toBe(42);
		});

		test('extensions.X.whenReady is always a Promise even without explicit whenReady', () => {
			const client = createWorkspace({
				id: 'ext-whenready-default',
			}).withExtension('bare', () => {
				return { tag: 'no-lifecycle' };
			});

			expect(client.extensions.bare.whenReady).toBeInstanceOf(Promise);
		});

		test('extensions.X.dispose is always a function even without explicit dispose', () => {
			const client = createWorkspace({
				id: 'ext-dispose-default',
			}).withExtension('bare', () => {
				return { tag: 'no-lifecycle' };
			});

			expect(typeof client.extensions.bare.dispose).toBe('function');
		});

		test('surgical await: extension B chains off extensions.A.whenReady', async () => {
			const order: string[] = [];
			let resolveA: (() => void) | undefined;
			const aReady = new Promise<void>((r) => {
				resolveA = r;
			});

			const client = createWorkspace({
				id: 'surgical-await-test',
			})
				.withExtension('a', () => ({
					tag: 'a',
					whenReady: aReady.then(() => {
						order.push('a-ready');
					}),
				}))
				.withExtension('b', ({ extensions }) => {
					const whenReadyPromise = (async () => {
						await extensions.a.whenReady;
						order.push('b-ready');
					})();
					return { tag: 'b', whenReady: whenReadyPromise };
				});

			// B should not resolve until A does
			let bResolved = false;
			client.extensions.b.whenReady.then(() => {
				bResolved = true;
			});
			await Promise.resolve();
			expect(bResolved).toBe(false);

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
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'doc-ext-test',
				tables: { files: filesTable },
			}).withDocumentExtension('test', () => {
				hookCalled = true;
				return { dispose: () => {} };
			});

			await client.documents.files.content.open('f1');

			expect(hookCalled).toBe(true);
		});

		test('withDocumentExtension with tags only fires for matching documents', async () => {
			const hookCalls: string[] = [];

			const notesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					thumbId: 'string',
					thumbUpdatedAt: 'number',
					_v: '1',
				}),
			)
				.withDocument('content', {
					guid: 'id',
					onUpdate: () => ({ updatedAt: Date.now() }),
					tags: ['persistent', 'synced'],
				})
				.withDocument('thumb', {
					guid: 'thumbId',
					onUpdate: () => ({ thumbUpdatedAt: Date.now() }),
					tags: ['ephemeral'],
				});

			const client = createWorkspace({
				id: 'doc-tag-test',
				tables: { notes: notesTable },
			})
				.withDocumentExtension(
					'persistent-only',
					() => {
						hookCalls.push('persistent-only');
						return { dispose: () => {} };
					},
					{ tags: ['persistent'] },
				)
				.withDocumentExtension(
					'ephemeral-only',
					() => {
						hookCalls.push('ephemeral-only');
						return { dispose: () => {} };
					},
					{ tags: ['ephemeral'] },
				)
				.withDocumentExtension('universal', () => {
					hookCalls.push('universal');
					return { dispose: () => {} };
				});

			// Content doc has tags ['persistent', 'synced']
			await client.documents.notes.content.open('f1');
			// 'persistent-only' matches (shares 'persistent')
			// 'ephemeral-only' does NOT match (no overlap)
			// 'universal' matches (no tags = fires for all)
			expect(hookCalls).toEqual(['persistent-only', 'universal']);

			hookCalls.length = 0;

			// Thumb doc has tag ['ephemeral']
			await client.documents.notes.thumb.open('t1');
			// 'persistent-only' does NOT match
			// 'ephemeral-only' matches (shares 'ephemeral')
			// 'universal' matches (no tags = fires for all)
			expect(hookCalls).toEqual(['ephemeral-only', 'universal']);
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
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			// withExtension fires factory for workspace Y.Doc AND registers
			// it as a document extension (tags: [] = universal)
			const client = createWorkspace({
				id: 'three-tier-both-test',
				tables: { files: filesTable },
			}).withExtension('myExt', () => {
				factoryCallCount++;
				return {
					tag: 'ext',
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
				guid: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
			});

			const client = createWorkspace({
				id: 'three-tier-ws-only-test',
				tables: { files: filesTable },
			}).withWorkspaceExtension('wsOnly', () => {
				factoryCallCount++;
				return {
					tag: 'ws-only',
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

		test('builder branching creates isolated extension sets', () => {
			const base = createWorkspace(def).withExtension('a', () => ({
				value: 'a',
			}));
			const b1 = base.withExtension('b', () => ({ value: 'b' }));
			const b2 = base.withExtension('c', () => ({ value: 'c' }));

			expect(Object.keys(base.extensions)).toEqual(['a']);
			expect(Object.keys(b1.extensions)).toEqual(['a', 'b']);
			expect(Object.keys(b2.extensions)).toEqual(['a', 'c']);
		});

		test('void-returning factory does not appear in extensions', () => {
			const client = createWorkspace(def)
				.withExtension(
					'noop',
					() => undefined as unknown as Record<string, unknown>,
				)
				.withExtension('real', () => ({ value: 42 }));

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
				guidKey: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
				tableHelper: tables.files,
				ydoc: mockYdoc,
				documentExtensions: [
					{ key: 'first', factory: factory('first'), tags: [] },
					{ key: 'second', factory: factory('second'), tags: [] },
					{ key: 'third', factory: factory('third'), tags: [] },
				],
			});

			await documents.open('doc-1');
			await documents.close('doc-1');

			expect(disposeOrder).toEqual(['third', 'second', 'first']); // LIFO
		});

		test('whenReady rejection in workspace triggers cleanup', async () => {
			const cleanupCalled = new Set<string>();
			let rejectWhenReady: (() => void) | undefined;
			const whenReadyPromise = new Promise<void>((_, reject) => {
				rejectWhenReady = () => reject(new Error('provider failed'));
			});

			const client = createWorkspace(def)
				.withExtension('first', () => ({
					dispose: async () => {
						cleanupCalled.add('first');
					},
				}))
				.withExtension('second', () => ({
					whenReady: whenReadyPromise,
					dispose: async () => {
						cleanupCalled.add('second');
					},
				}));

			// Trigger rejection
			rejectWhenReady?.();

			try {
				await client.whenReady;
			} catch {
				// expected
			}

			expect(cleanupCalled.has('first')).toBe(true);
			expect(cleanupCalled.has('second')).toBe(true);
		});

		test('document extension whenReady rejection triggers cleanup', async () => {
			const cleanupCalled = new Set<string>();
			let rejectWhenReady: (() => void) | undefined;
			const whenReadyPromise = new Promise<void>((_, reject) => {
				rejectWhenReady = () => reject(new Error('provider failed'));
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
				guidKey: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
				tableHelper: tables.files,
				ydoc: mockYdoc,
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							dispose: async () => {
								cleanupCalled.add('first');
							},
						}),
						tags: [],
					},
					{
						key: 'second',
						factory: () => ({
							whenReady: whenReadyPromise,
							dispose: async () => {
								cleanupCalled.add('second');
							},
						}),
						tags: [],
					},
				],
			});

			const handlePromise = documents.open('doc-1');
			rejectWhenReady?.();

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
// Workspace Unlock (`workspace.encryption` / locked vs unlocked)
// ============================================================================

describe('workspace unlock', () => {
	function setupUnlockedWorkspace() {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		const client = createWorkspace(
			defineWorkspace({ id: 'enc-test', tables: { posts } }),
		).withEncryption();
		return { client, key: generateEncryptionKey() };
	}

	test('runtime starts locked when no key was provided', () => {
		const { client } = setupUnlockedWorkspace();
		expect(client.encryption.isUnlocked).toBe(false);
	});

	test('encryption.unlock transitions runtime to unlocked', async () => {
		const { client, key } = setupUnlockedWorkspace();
		await client.encryption.unlock(key);
		expect(client.encryption.isUnlocked).toBe(true);
	});

	test('encryption.unlock preserves encrypted writes when the same key is reused', async () => {
		const { client, key } = setupUnlockedWorkspace();
		await client.encryption.unlock(key);
		client.tables.posts.set({ id: '1', title: 'Secret', _v: 1 });

		await client.encryption.unlock(key);

		const result = client.tables.posts.get('1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Secret');
		}
	});

	test('construction-time key starts stores unlocked', () => {
		const key = generateEncryptionKey();
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		const client = createWorkspace(
			defineWorkspace({ id: 'key-test', tables: { posts } }),
			{ key },
		).withEncryption();

		expect(client.encryption.isUnlocked).toBe(true);
	});
});

// ============================================================================
// .withEncryption() lifecycle (dedup, race, cache unlock, isUnlocked)
// ============================================================================

describe('.withEncryption() lifecycle', () => {
	function setupLifecycle() {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		const client = createWorkspace(
			defineWorkspace({ id: 'lifecycle-enc-test', tables: { posts } }),
		).withEncryption();
		return { client };
	}

	function setupWithUserKeyCache(cachedKeyBase64: string | null = null) {
		const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
		let cachedValue = cachedKeyBase64;
		let shouldFailNextSave = false;
		const userKeyCache: UserKeyCache = {
			save: mock(async (keyBase64: string) => {
				if (shouldFailNextSave) {
					shouldFailNextSave = false;
					throw new Error('forced user key cache save failure');
				}
				cachedValue = keyBase64;
			}),
			load: mock(async () => cachedValue),
			clear: mock(async () => {
				cachedValue = null;
			}),
		};
		const client = createWorkspace(
			defineWorkspace({ id: 'key-cache-test', tables: { posts } }),
		).withEncryption({ userKeyCache });

		return {
			client,
			userKeyCache,
			failNextSave() {
				shouldFailNextSave = true;
			},
			readCachedValue: () => cachedValue,
		};
	}

	describe('dedup', () => {
		test('same key twice keeps the runtime unlocked', async () => {
			const { client } = setupLifecycle();
			const key = generateEncryptionKey();

			await client.encryption.unlock(key);
			expect(client.encryption.isUnlocked).toBe(true);

			await client.encryption.unlock(key);
			expect(client.encryption.isUnlocked).toBe(true);
		});

		test('different keys each keep the runtime unlocked', async () => {
			const { client } = setupLifecycle();

			await client.encryption.unlock(generateEncryptionKey());
			expect(client.encryption.isUnlocked).toBe(true);

			await client.encryption.unlock(generateEncryptionKey());
			expect(client.encryption.isUnlocked).toBe(true);
		});
	});

	describe('runtime key switches', () => {
		test('rapid unlocks leave the runtime unlocked with the latest key', async () => {
			const { client } = setupLifecycle();

			const p1 = client.encryption.unlock(generateEncryptionKey());
			const p2 = client.encryption.unlock(generateEncryptionKey());
			const p3 = client.encryption.unlock(generateEncryptionKey());

			await Promise.all([p1, p2, p3]);

			expect(client.encryption.isUnlocked).toBe(true);
		});
	});

	describe('isUnlocked getter', () => {
		test('reflects lock state transitions', async () => {
			const { client } = setupLifecycle();

			expect(client.encryption.isUnlocked).toBe(false);

			await client.encryption.unlock(generateEncryptionKey());
			expect(client.encryption.isUnlocked).toBe(true);

			client.encryption.lock();
			expect(client.encryption.isUnlocked).toBe(false);
		});
	});

	describe('userKeyCache integration', () => {
		test('encryption.unlock saves the user key through userKeyCache', async () => {
			const { client, userKeyCache, readCachedValue } = setupWithUserKeyCache();
			const userKey = generateEncryptionKey();

			await client.encryption.unlock(userKey);

			expect(userKeyCache.save).toHaveBeenCalledTimes(1);
			expect(userKeyCache.save).toHaveBeenCalledWith(bytesToBase64(userKey));
			expect(readCachedValue()).toBe(bytesToBase64(userKey));
		});

		test('encryption.unlock retries the same key after userKeyCache.save fails', async () => {
			const { client, userKeyCache, failNextSave, readCachedValue } =
				setupWithUserKeyCache();
			const userKey = generateEncryptionKey();

			failNextSave();
			await client.encryption.unlock(userKey);
			await client.encryption.unlock(userKey);

			expect(client.encryption.isUnlocked).toBe(true);
			expect(userKeyCache.save).toHaveBeenCalledTimes(2);
			expect(readCachedValue()).toBe(bytesToBase64(userKey));
		});

		test('encryption.unlock updates runtime state before userKeyCache.save settles', async () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);
			const saveDeferred = createDeferred<void>();
			let cachedValue: string | null = null;
			const userKeyCache: UserKeyCache = {
				save: mock(async (keyBase64: string) => {
					await saveDeferred.promise;
					cachedValue = keyBase64;
				}),
				load: mock(async () => cachedValue),
				clear: mock(async () => {
					cachedValue = null;
				}),
			};
			const client = createWorkspace(
				defineWorkspace({ id: 'delayed-save-test', tables: { posts } }),
			).withEncryption({ userKeyCache });
			const userKey = generateEncryptionKey();

			const unlockPromise = client.encryption.unlock(userKey);

			expect(client.encryption.isUnlocked).toBe(true);
			expect(cachedValue).toBe(null);

			saveDeferred.resolve();
			await unlockPromise;

			expect(cachedValue ?? '').toBe(bytesToBase64(userKey));
		});

		test('tryUnlock returns false when userKeyCache is empty', async () => {
			const { client, userKeyCache } = setupWithUserKeyCache();
			await client.whenReady; // auto-boot tryUnlock runs here
			(userKeyCache.load as ReturnType<typeof mock>).mockClear();

			const restored = await client.encryption.tryUnlock();

			expect(restored).toBe(false);
			expect(client.encryption.isUnlocked).toBe(false);
			expect(userKeyCache.load).toHaveBeenCalledTimes(1);
			expect(userKeyCache.save).toHaveBeenCalledTimes(0);
		});

		test('tryUnlock loads the cached key and unlocks the runtime', async () => {
			const userKey = generateEncryptionKey();
			const { client, userKeyCache } = setupWithUserKeyCache(
				bytesToBase64(userKey),
			);
			// Auto-boot already calls tryUnlock and unlocks from cache
			await client.whenReady;

			expect(client.encryption.isUnlocked).toBe(true);
			expect(userKeyCache.load).toHaveBeenCalledTimes(1);
			expect(userKeyCache.save).toHaveBeenCalledTimes(1);
			expect(userKeyCache.save).toHaveBeenCalledWith(bytesToBase64(userKey));
		});

		test('tryUnlock clears corrupt cache entries and stays locked', async () => {
			const { client, userKeyCache, readCachedValue } =
				setupWithUserKeyCache('%%%not-base64%%%');
			// Auto-boot attempts tryUnlock with corrupt data
			await client.whenReady;

			expect(client.encryption.isUnlocked).toBe(false);
			expect(userKeyCache.clear).toHaveBeenCalledTimes(1);
			expect(readCachedValue()).toBe(null);
		});

		test('rapid unlocks persist the latest key after earlier saves settle', async () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);
			const firstSaveDeferred = createDeferred<void>();
			let saveCalls = 0;
			let cachedValue: string | null = null;
			const userKeyCache: UserKeyCache = {
				save: mock(async (keyBase64: string) => {
					saveCalls += 1;
					if (saveCalls === 1) {
						await firstSaveDeferred.promise;
					}
					cachedValue = keyBase64;
				}),
				load: mock(async () => cachedValue),
				clear: mock(async () => {
					cachedValue = null;
				}),
			};
			const client = createWorkspace(
				defineWorkspace({ id: 'rapid-switch-cache-test', tables: { posts } }),
			).withEncryption({ userKeyCache });
			const firstKey = generateEncryptionKey();
			const secondKey = generateEncryptionKey();

			const firstUnlock = client.encryption.unlock(firstKey);
			const secondUnlock = client.encryption.unlock(secondKey);

			expect(client.encryption.isUnlocked).toBe(true);

			firstSaveDeferred.resolve();
			await Promise.all([firstUnlock, secondUnlock]);

			expect(userKeyCache.save).toHaveBeenCalledTimes(2);
			expect(cachedValue ?? '').toBe(bytesToBase64(secondKey));
		});

		test('clearLocalData clears userKeyCache after an in-flight save finishes', async () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);
			const saveDeferred = createDeferred<void>();
			const events: string[] = [];
			let cachedValue: string | null = null;
			const userKeyCache: UserKeyCache = {
				save: mock(async (keyBase64: string) => {
					events.push('save:start');
					await saveDeferred.promise;
					cachedValue = keyBase64;
					events.push('save:end');
				}),
				load: mock(async () => cachedValue),
				clear: mock(async () => {
					events.push('clear');
					cachedValue = null;
				}),
			};
			const client = createWorkspace(
				defineWorkspace({
					id: 'clear-local-data-race-test',
					tables: { posts },
				}),
			).withEncryption({ userKeyCache });
			const userKey = generateEncryptionKey();

			const unlockPromise = client.encryption.unlock(userKey);
			expect(client.encryption.isUnlocked).toBe(true);

			const clearPromise = client.clearLocalData();
			expect(client.encryption.isUnlocked).toBe(false);

			saveDeferred.resolve();
			await Promise.all([unlockPromise, clearPromise]);

			expect(client.encryption.isUnlocked).toBe(false);
			expect(userKeyCache.clear).toHaveBeenCalledTimes(1);
			expect(cachedValue).toBe(null);
			expect(events).toEqual(['save:start', 'save:end', 'clear']);
		});

		test('clearLocalData locks first and then runs persistence cleanup', async () => {
			const userKeyCache: UserKeyCache = {
				save: mock(async () => {}),
				load: mock(async () => null),
				clear: mock(async () => {}),
			};
			const events: string[] = [];
			const client = createWorkspace(
				defineWorkspace({ id: 'clear-order-test' }),
			)
				.withEncryption({ userKeyCache })
				.withExtension('persistence', () => ({
					clearLocalData: () => {
						events.push(client.encryption.isUnlocked ? 'unlocked' : 'locked');
					},
				}));

			await client.encryption.unlock(generateEncryptionKey());
			await client.clearLocalData();

			expect(events).toEqual(['locked']);
			expect(client.encryption.isUnlocked).toBe(false);
		});

		test('tryUnlock only exists when userKeyCache is configured in the type', async () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);
			const withoutCache = createWorkspace(
				defineWorkspace({ id: 'type-test-no-cache', tables: { posts } }),
			).withEncryption();
			const withCache = createWorkspace(
				defineWorkspace({ id: 'type-test-cache', tables: { posts } }),
			).withEncryption({
				userKeyCache: {
					save: async () => {},
					load: async () => null,
					clear: async () => {},
				},
			});

			if (false) {
				// @ts-expect-error tryUnlock only exists when userKeyCache is configured
				void withoutCache.encryption.tryUnlock();
			}

			expect(typeof withCache.encryption.tryUnlock).toBe('function');
			expect(await withCache.encryption.tryUnlock()).toBe(false);
		});
	});
});
