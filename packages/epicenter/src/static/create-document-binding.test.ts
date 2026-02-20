import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	createDocumentBinding,
	DOCUMENT_BINDING_ORIGIN,
} from './create-document-binding.js';
import { createTables } from './create-tables.js';
import { defineTable } from './define-table.js';

const fileSchema = type({
	id: 'string',
	name: 'string',
	updatedAt: 'number',
	_v: '1',
});

function setup() {
	const tableDef = defineTable(fileSchema);
	const ydoc = new Y.Doc({ guid: 'test-workspace' });
	const tables = createTables(ydoc, { files: tableDef });
	return { ydoc, tables };
}

function setupWithBinding(
	overrides?: Omit<
		Partial<Parameters<typeof createDocumentBinding>[0]>,
		'guidKey' | 'updatedAtKey' | 'tableHelper' | 'ydoc'
	>,
) {
	const { ydoc, tables } = setup();
	const binding = createDocumentBinding({
		guidKey: 'id',
		updatedAtKey: 'updatedAt',
		tableHelper: tables.files,
		ydoc,
		...overrides,
	});
	return { ydoc, tables, binding };
}

describe('createDocumentBinding', () => {
	describe('open', () => {
		test('returns a Y.Doc with gc: false', async () => {
			const { tables, binding } = setupWithBinding();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const doc = await binding.open('f1');
			expect(doc).toBeInstanceOf(Y.Doc);
			expect(doc.gc).toBe(false);
		});

		test('is idempotent — same GUID returns same Y.Doc', async () => {
			const { binding } = setupWithBinding();

			const doc1 = await binding.open('f1');
			const doc2 = await binding.open('f1');
			expect(doc1).toBe(doc2);
		});

		test('accepts a row object', async () => {
			const { tables, binding } = setupWithBinding();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1 as const,
			};
			tables.files.set(row);

			const doc = await binding.open(row);
			expect(doc.guid).toBe('f1');
		});

		test('accepts a string GUID', async () => {
			const { binding } = setupWithBinding();

			const doc = await binding.open('f1');
			expect(doc.guid).toBe('f1');
		});
	});

	describe('read and write', () => {
		test('read returns empty string for new doc', async () => {
			const { binding } = setupWithBinding();

			const text = await binding.read('f1');
			expect(text).toBe('');
		});

		test('write replaces text content, then read returns it', async () => {
			const { binding } = setupWithBinding();

			await binding.write('f1', 'hello world');
			const text = await binding.read('f1');
			expect(text).toBe('hello world');
		});

		test('write replaces existing content', async () => {
			const { binding } = setupWithBinding();

			await binding.write('f1', 'first');
			await binding.write('f1', 'second');
			const text = await binding.read('f1');
			expect(text).toBe('second');
		});
	});

	describe('updatedAt auto-bump', () => {
		test('content doc change bumps updatedAt on the row', async () => {
			const { tables, binding } = setupWithBinding();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const doc = await binding.open('f1');
			doc.getText('content').insert(0, 'hello');

			// Give the update observer a tick
			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBeGreaterThan(0);
			}
		});

		test('updatedAt bump uses DOCUMENT_BINDING_ORIGIN', async () => {
			const { tables, binding } = setupWithBinding();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			let capturedOrigin: unknown = null;
			tables.files.observe((_changedIds, transaction) => {
				capturedOrigin = (transaction as Y.Transaction).origin;
			});

			const doc = await binding.open('f1');
			doc.getText('content').insert(0, 'hello');

			expect(capturedOrigin).toBe(DOCUMENT_BINDING_ORIGIN);
		});

		test('remote update does NOT bump updatedAt', async () => {
			const { tables, binding } = setupWithBinding();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const doc = await binding.open('f1');

			// Capture the state update from a local edit on a separate Y.Doc,
			// then apply it as a "remote" update via Y.applyUpdate
			const remoteDoc = new Y.Doc({ guid: 'f1', gc: false });
			remoteDoc.getText('content').insert(0, 'remote edit');
			const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);

			Y.applyUpdate(doc, remoteUpdate);

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(0);
			}

			remoteDoc.destroy();
		});
	});

	describe('destroy', () => {
		test('frees memory — doc can be re-opened as new instance', async () => {
			const { binding } = setupWithBinding();

			const doc1 = await binding.open('f1');
			await binding.destroy('f1');

			const doc2 = await binding.open('f1');
			expect(doc2).not.toBe(doc1);
		});

		test('destroy is safe on non-existent guid', async () => {
			const { binding } = setupWithBinding();

			// Should not throw
			await binding.destroy('nonexistent');
		});
	});

	describe('purge', () => {
		test('calls clearData on providers that support it', async () => {
			let clearDataCalled = false;
			const { tables, binding } = setupWithBinding({
				documentExtensions: [
					{
						key: 'test',
						factory: () => ({
							destroy: () => {},
							clearData: () => {
								clearDataCalled = true;
							},
						}),
						tags: [],
					},
				],
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			await binding.open('f1');
			await binding.purge('f1');

			expect(clearDataCalled).toBe(true);
		});

		test('purge gracefully handles providers without clearData', async () => {
			let destroyCalled = false;
			const { binding } = setupWithBinding({
				documentExtensions: [
					{
						key: 'test',
						factory: () => ({
							destroy: () => {
								destroyCalled = true;
							},
							// no clearData
						}),
						tags: [],
					},
				],
			});

			await binding.open('f1');
			await binding.purge('f1');

			expect(destroyCalled).toBe(true);
		});

		test('purge opens doc if not already open', async () => {
			let openedByPurge = false;
			const { binding } = setupWithBinding({
				documentExtensions: [
					{
						key: 'test',
						factory: () => {
							openedByPurge = true;
							return {
								destroy: () => {},
								clearData: () => {},
							};
						},
						tags: [],
					},
				],
			});

			// Don't call open first — purge should do it
			await binding.purge('f1');
			expect(openedByPurge).toBe(true);
		});
	});

	describe('destroyAll', () => {
		test('destroys all open docs', async () => {
			const { binding } = setupWithBinding();

			const doc1 = await binding.open('f1');
			const doc2 = await binding.open('f2');

			await binding.destroyAll();

			// Re-opening should create new instances
			const doc1b = await binding.open('f1');
			const doc2b = await binding.open('f2');
			expect(doc1b).not.toBe(doc1);
			expect(doc2b).not.toBe(doc2);
		});
	});

	describe('row deletion', () => {
		test('default onRowDeleted calls destroy', async () => {
			const { tables, binding } = setupWithBinding();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const doc1 = await binding.open('f1');
			tables.files.delete('f1');

			// After deletion, re-opening should create a new Y.Doc
			const doc2 = await binding.open('f1');
			expect(doc2).not.toBe(doc1);
		});

		test('custom onRowDeleted fires with the guid', async () => {
			let deletedGuid = '';
			const { tables } = setup();

			const binding = createDocumentBinding({
				guidKey: 'id',
				updatedAtKey: 'updatedAt',
				tableHelper: tables.files,
				ydoc: new Y.Doc({ guid: 'test' }),
				onRowDeleted: (_binding, guid) => {
					deletedGuid = guid;
				},
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			await binding.open('f1');
			tables.files.delete('f1');

			expect(deletedGuid).toBe('f1');
		});
	});

	describe('guidOf and updatedAtOf', () => {
		test('guidOf extracts the guid column value', () => {
			const { binding } = setupWithBinding();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 123,
				_v: 1 as const,
			};
			expect(binding.guidOf(row)).toBe('f1');
		});

		test('updatedAtOf extracts the updatedAt column value', () => {
			const { binding } = setupWithBinding();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 456,
				_v: 1 as const,
			};
			expect(binding.updatedAtOf(row)).toBe(456);
		});
	});

	describe('document extension hooks', () => {
		test('hooks are called in order', async () => {
			const order: number[] = [];

			const { binding } = setupWithBinding({
				documentExtensions: [
					{
						key: 'first',
						factory: () => {
							order.push(1);
							return { destroy: () => {} };
						},
						tags: [],
					},
					{
						key: 'second',
						factory: () => {
							order.push(2);
							return { destroy: () => {} };
						},
						tags: [],
					},
					{
						key: 'third',
						factory: () => {
							order.push(3);
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await binding.open('f1');
			expect(order).toEqual([1, 2, 3]);
		});

		test('second hook receives whenReady from first', async () => {
			let secondReceivedWhenReady = false;

			const { binding } = setupWithBinding({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							whenReady: Promise.resolve(),
							destroy: () => {},
						}),
						tags: [],
					},
					{
						key: 'second',
						factory: ({ whenReady }) => {
							secondReceivedWhenReady = whenReady instanceof Promise;
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await binding.open('f1');
			expect(secondReceivedWhenReady).toBe(true);
		});

		test('hook returning void is skipped', async () => {
			let hooksCalled = 0;

			const { binding } = setupWithBinding({
				documentExtensions: [
					{
						key: 'void-hook',
						factory: () => {
							hooksCalled++;
							return undefined; // void return
						},
						tags: [],
					},
					{
						key: 'normal-hook',
						factory: () => {
							hooksCalled++;
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await binding.open('f1');
			expect(hooksCalled).toBe(2);
		});

		test('no hooks → bare Y.Doc, instant resolution', async () => {
			const { binding } = setupWithBinding({ documentExtensions: [] });

			const doc = await binding.open('f1');
			expect(doc).toBeInstanceOf(Y.Doc);
		});

		test('hook receives correct binding metadata with tags', async () => {
			let capturedBinding:
				| {
						tableName: string;
						documentName: string;
						tags: readonly string[];
				  }
				| undefined;

			const { ydoc, tables } = setup();
			const binding = createDocumentBinding({
				guidKey: 'id',
				updatedAtKey: 'updatedAt',
				tableHelper: tables.files,
				ydoc,
				tableName: 'files',
				documentName: 'content',
				documentTags: ['persistent', 'synced'],
				documentExtensions: [
					{
						key: 'capture',
						factory: (ctx) => {
							capturedBinding = ctx.binding;
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await binding.open('f1');
			expect(capturedBinding).toBeDefined();
			expect(capturedBinding!.tableName).toBe('files');
			expect(capturedBinding!.documentName).toBe('content');
			expect(capturedBinding!.tags).toEqual(['persistent', 'synced']);
		});

		test('tag matching: extension with no tags fires for all docs', async () => {
			let called = false;
			const { binding } = setupWithBinding({
				documentTags: ['persistent'],
				documentExtensions: [
					{
						key: 'universal',
						factory: () => {
							called = true;
							return { destroy: () => {} };
						},
						tags: [], // universal — no tags
					},
				],
			});

			await binding.open('f1');
			expect(called).toBe(true);
		});

		test('tag matching: extension with matching tag fires', async () => {
			let called = false;
			const { binding } = setupWithBinding({
				documentTags: ['persistent', 'synced'],
				documentExtensions: [
					{
						key: 'sync-ext',
						factory: () => {
							called = true;
							return { destroy: () => {} };
						},
						tags: ['synced'],
					},
				],
			});

			await binding.open('f1');
			expect(called).toBe(true);
		});

		test('tag matching: extension with non-matching tag does NOT fire', async () => {
			let called = false;
			const { binding } = setupWithBinding({
				documentTags: ['persistent'],
				documentExtensions: [
					{
						key: 'ephemeral-ext',
						factory: () => {
							called = true;
							return { destroy: () => {} };
						},
						tags: ['ephemeral'],
					},
				],
			});

			await binding.open('f1');
			expect(called).toBe(false);
		});

		test('tag matching: doc with no tags only gets universal extensions', async () => {
			const calls: string[] = [];
			const { binding } = setupWithBinding({
				documentTags: [], // no tags on doc
				documentExtensions: [
					{
						key: 'tagged',
						factory: () => {
							calls.push('tagged');
							return { destroy: () => {} };
						},
						tags: ['persistent'],
					},
					{
						key: 'universal',
						factory: () => {
							calls.push('universal');
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await binding.open('f1');
			expect(calls).toEqual(['universal']);
		});
	});
});
