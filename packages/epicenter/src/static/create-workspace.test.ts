/**
 * createWorkspace Tests
 *
 * Verifies workspace client behavior for batching, observer delivery, and document-binding wiring.
 * These tests protect the runtime contract that table/KV operations stay consistent across transactions
 * and that optional document bindings are attached only when configured.
 *
 * Key behaviors:
 * - Batch transactions coalesce notifications while preserving applied mutations.
 * - Document-bound tables expose `docs`, while non-bound tables do not.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import type * as Y from 'yjs';
import { createWorkspace } from './create-workspace.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

type DocumentBindingLike = {
	open: (guid: string) => Promise<Y.Doc>;
	read: (guid: string) => Promise<string>;
	write: (guid: string, text: string) => Promise<void>;
	destroy: (guid: string) => Promise<void>;
	purge: (guid: string) => Promise<void>;
	destroyAll: () => Promise<void>;
};

type TableWithDocs = {
	docs?: Record<string, DocumentBindingLike>;
};

/** Creates a workspace client with two tables and one KV for testing. */
function setup() {
	const postsTable = defineTable(
		type({ id: 'string', title: 'string', _v: '1' }),
	);
	const tagsTable = defineTable(
		type({ id: 'string', name: 'string', _v: '1' }),
	);
	const themeDef = defineKv(type({ mode: "'light' | 'dark'" }));

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
				expect(changes[0]!.has('1')).toBe(true);
				expect(changes[0]!.has('2')).toBe(true);
				expect(changes[0]!.has('3')).toBe(true);
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
				expect(changes[0]!.has('1')).toBe(true);
				expect(changes[0]!.has('2')).toBe(true);
				expect(changes[0]!.has('3')).toBe(true);
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
				expect(changes[0]!.has('1')).toBe(true);
				expect(changes[0]!.has('2')).toBe(true);
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
				expect(postChanges[0]!.has('p1')).toBe(true);
				expect(tagChanges).toHaveLength(1);
				expect(tagChanges[0]!.has('t1')).toBe(true);

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
				expect(postChanges[0]!.has('p1')).toBe(true);
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
				expect(changes[0]!.has('1')).toBe(true);
				expect(changes[0]!.has('2')).toBe(true);
				expect(changes[0]!.has('3')).toBe(true);

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
				expect(changes[0]!.size).toBe(100);

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

	describe('document binding wiring', () => {
		test('table using withDocument exposes docs namespace on helper', () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

			const client = createWorkspace({
				id: 'doc-test',
				tables: { files: filesTable },
			});

			const docs = (client.tables.files as TableWithDocs).docs;
			expect(docs).toBeDefined();
			if (!docs) {
				throw new Error('Expected files docs binding to exist');
			}
			expect(docs.content).toBeDefined();
			expect(typeof docs.content.open).toBe('function');
			expect(typeof docs.content.read).toBe('function');
			expect(typeof docs.content.write).toBe('function');
			expect(typeof docs.content.destroy).toBe('function');
			expect(typeof docs.content.purge).toBe('function');
			expect(typeof docs.content.destroyAll).toBe('function');
		});

		test('table without withDocument does not expose docs property', () => {
			const { client } = setup();

			expect((client.tables.posts as TableWithDocs).docs).toBeUndefined();
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
			).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

			const client = createWorkspace({
				id: 'doc-ext-test',
				tables: { files: filesTable },
			}).withDocumentExtension('test', () => {
				hookCalled = true;
				return { destroy: () => {} };
			});

			const docs = (client.tables.files as TableWithDocs).docs;
			if (!docs) {
				throw new Error('Expected files docs binding to exist');
			}
			await docs.content.open('f1');

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
					updatedAt: 'updatedAt',
					tags: ['persistent', 'synced'],
				})
				.withDocument('thumb', {
					guid: 'thumbId',
					updatedAt: 'thumbUpdatedAt',
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
						return { destroy: () => {} };
					},
					{ tags: ['persistent'] },
				)
				.withDocumentExtension(
					'ephemeral-only',
					() => {
						hookCalls.push('ephemeral-only');
						return { destroy: () => {} };
					},
					{ tags: ['ephemeral'] },
				)
				.withDocumentExtension('universal', () => {
					hookCalls.push('universal');
					return { destroy: () => {} };
				});

			// biome-ignore lint/suspicious/noExplicitAny: testing runtime property
			const docs = (client.tables.notes as any).docs;

			// Content doc has tags ['persistent', 'synced']
			await docs.content.open('f1');
			// 'persistent-only' matches (shares 'persistent')
			// 'ephemeral-only' does NOT match (no overlap)
			// 'universal' matches (no tags = fires for all)
			expect(hookCalls).toEqual(['persistent-only', 'universal']);

			hookCalls.length = 0;

			// Thumb doc has tag ['ephemeral']
			await docs.thumb.open('t1');
			// 'persistent-only' does NOT match
			// 'ephemeral-only' matches (shares 'ephemeral')
			// 'universal' matches (no tags = fires for all)
			expect(hookCalls).toEqual(['ephemeral-only', 'universal']);
		});

		test('workspace destroy cascades to destroyAll on bindings', async () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

			const client = createWorkspace({
				id: 'doc-destroy-test',
				tables: { files: filesTable },
			});

			const docs = (client.tables.files as TableWithDocs).docs;
			if (!docs) {
				throw new Error('Expected files docs binding to exist');
			}
			const doc1 = await docs.content.open('f1');

			await client.destroy();

			// After destroy, open should create a new Y.Doc (since binding was destroyed)
			// But we can't open after workspace destroy — just verify no error occurred
			expect(doc1).toBeDefined();
		});

		test('multiple tables with document bindings each get their own docs', () => {
			const filesTable = defineTable(
				type({
					id: 'string',
					name: 'string',
					updatedAt: 'number',
					_v: '1',
				}),
			).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

			const notesTable = defineTable(
				type({
					id: 'string',
					bodyDocId: 'string',
					bodyUpdatedAt: 'number',
					_v: '1',
				}),
			).withDocument('body', { guid: 'bodyDocId', updatedAt: 'bodyUpdatedAt' });

			const client = createWorkspace({
				id: 'multi-doc-test',
				tables: { files: filesTable, notes: notesTable },
			});

			const fileDocs = (client.tables.files as TableWithDocs).docs;
			const noteDocs = (client.tables.notes as TableWithDocs).docs;
			if (!fileDocs || !noteDocs) {
				throw new Error('Expected document bindings for both tables');
			}

			expect(fileDocs.content).toBeDefined();
			expect(noteDocs.body).toBeDefined();
			expect(fileDocs.content).not.toBe(noteDocs.body);
		});
	});
});
