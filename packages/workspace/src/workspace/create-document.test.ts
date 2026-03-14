/**
 * createDocuments Tests
 *
 * Validates documents lifecycle, handle read/write behavior, and integration with table row metadata.
 * The suite protects contracts around open/close idempotency, handle pattern, cleanup semantics, and hook orchestration.
 *
 * Key behaviors:
 * - Document operations keep row metadata in sync and honor documents origins.
 * - Lifecycle methods (`close`, `closeAll`) safely clean up open documents.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	type CreateDocumentsConfig,
	createDocuments,
	DOCUMENTS_ORIGIN,
} from './create-document.js';
import { createTables } from './create-tables.js';
import { defineTable } from './define-table.js';

const fileSchema = type({
	id: 'string',
	name: 'string',
	updatedAt: 'number',
	_v: '1',
});

function setupTables() {
	const ydoc = new Y.Doc({ guid: 'test-workspace' });
	const tables = createTables(ydoc, { files: defineTable(fileSchema) });
	return { ydoc, tables };
}

function setup(
	overrides?: Pick<
		CreateDocumentsConfig<typeof fileSchema.infer>,
		'documentExtensions' | 'documentTags' | 'onRowDeleted'
	>,
) {
	const { ydoc, tables } = setupTables();
	const documents = createDocuments({
		guidKey: 'id',
		onUpdate: () => ({ updatedAt: Date.now() }),
		tableHelper: tables.files,
		ydoc,
		...overrides,
	});
	return { ydoc, tables, documents };
}

describe('createDocuments', () => {
	describe('open', () => {
		test('returns a handle with a Y.Doc (gc: false)', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const handle = await documents.open('f1');
			expect(handle.ydoc).toBeInstanceOf(Y.Doc);
			expect(handle.ydoc.gc).toBe(false);
		});

		test('is idempotent — same GUID returns same underlying Y.Doc', async () => {
			const { documents } = setup();

			const handle1 = await documents.open('f1');
			const handle2 = await documents.open('f1');
			expect(handle1.ydoc).toBe(handle2.ydoc);
		});

		test('open accepts a row object and resolves guid', async () => {
			const { tables, documents } = setup();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			} as const;
			tables.files.set(row);

			const handle = await documents.open(row);
			expect(handle.ydoc.guid).toBe('f1');
		});

		test('open accepts a string guid directly', async () => {
			const { documents } = setup();

			const handle = await documents.open('f1');
			expect(handle.ydoc.guid).toBe('f1');
		});
	});

	describe('handle content read and write', () => {
		test('read returns empty string for new doc', async () => {
			const { documents } = setup();

			const handle = await documents.open('f1');
			const text = handle.content.read();
			expect(text).toBe('');
		});

		test('write replaces text content, then read returns it', async () => {
			const { documents } = setup();

			const handle = await documents.open('f1');
			handle.content.write('hello world');
			const text = handle.content.read();
			expect(text).toBe('hello world');
		});

		test('write replaces existing content', async () => {
			const { documents } = setup();

			const handle = await documents.open('f1');
			handle.content.write('first');
			handle.content.write('second');
			const text = handle.content.read();
			expect(text).toBe('second');
		});
	});

	describe('onUpdate callback', () => {
		test('content doc change invokes onUpdate and writes returned fields', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const handle = await documents.open('f1');
			handle.content.write('hello');

			// Give the update observer a tick
			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBeGreaterThan(0);
			}
		});

		test('onUpdate callback return values are written to the row', async () => {
			const customSchema = type({
				id: 'string',
				name: 'string',
				updatedAt: 'number',
				lastEditedBy: 'string',
				_v: '1',
			});
			const ydoc = new Y.Doc({ guid: 'test-custom-onUpdate' });
			const tables = createTables(ydoc, {
				files: defineTable(customSchema),
			});

			const documents = createDocuments({
				guidKey: 'id',
				onUpdate: () => ({
					updatedAt: 999,
					lastEditedBy: 'test-user',
				}),
				tableHelper: tables.files,
				ydoc,
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				lastEditedBy: '',
				_v: 1,
			});

			const handle = await documents.open('f1');
			handle.content.write('hello');

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(999);
				expect(result.row.lastEditedBy).toBe('test-user');
			}
		});

		test('onUpdate returning empty object is a no-op', async () => {
			const ydoc = new Y.Doc({ guid: 'test-noop-onUpdate' });
			const tables = createTables(ydoc, {
				files: defineTable(fileSchema),
			});

			const documents = createDocuments({
				guidKey: 'id',
				onUpdate: () => ({}),
				tableHelper: tables.files,
				ydoc,
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const handle = await documents.open('f1');
			handle.content.write('hello');

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(0); // unchanged
			}
		});

		test('onUpdate bump uses DOCUMENTS_ORIGIN', async () => {
			const { tables, documents } = setup();
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

			const handle = await documents.open('f1');
			handle.content.write('hello');

			expect(capturedOrigin).toBe(DOCUMENTS_ORIGIN);
		});

		test('remote update does NOT invoke onUpdate', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const handle = await documents.open('f1');

			// Capture the state update from a local edit on a separate Y.Doc,
			// then apply it as a "remote" update via Y.applyUpdate
			const remoteDoc = new Y.Doc({ guid: 'f1', gc: false });
			remoteDoc.getText('content').insert(0, 'remote edit');
			const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);

			Y.applyUpdate(handle.ydoc, remoteUpdate);

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(0);
			}

			remoteDoc.destroy();
		});
	});

	describe('close', () => {
		test('frees memory — doc can be re-opened as new instance', async () => {
			const { documents } = setup();

			const handle1 = await documents.open('f1');
			await documents.close('f1');

			const handle2 = await documents.open('f1');
			expect(handle2.ydoc).not.toBe(handle1.ydoc);
		});

		test('close on non-existent guid is a no-op', async () => {
			const { documents } = setup();

			// Should not throw
			await documents.close('nonexistent');
		});
	});

	describe('handle.exports', () => {
		test('returns accumulated exports keyed by extension name', async () => {
			const { documents } = setup({
				documentExtensions: [
					{
						key: 'persistence',
						factory: () => ({
							clearData: () => {},
							destroy: () => {},
						}),
						tags: [],
					},
				],
			});

			const handle = await documents.open('f1');
			expect(handle.exports).toBeDefined();
			expect(handle.exports.persistence).toBeDefined();
			expect(typeof handle.exports.persistence?.clearData).toBe('function');
		});

		test('lifecycle-only extension is accessible with whenReady and destroy', async () => {
			const { documents } = setup({
				documentExtensions: [
					{
						key: 'lifecycle-only',
						factory: () => ({
							destroy: () => {},
						}),
						tags: [],
					},
				],
			});

			const handle = await documents.open('f1');
			expect(handle.exports).toBeDefined();
			const ext = handle.exports['lifecycle-only'];
			expect(ext).toBeDefined();
			expect(ext?.whenReady).toBeInstanceOf(Promise);
			expect(typeof ext?.destroy).toBe('function');
		});

		test('accepts a row object', async () => {
			const { tables, documents } = setup({
				documentExtensions: [
					{
						key: 'test',
						factory: () => ({
							helper: () => 42,
						}),
						tags: [],
					},
				],
			});

			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			} as const;
			tables.files.set(row);

			const handle = await documents.open(row);
			expect(handle.exports).toBeDefined();
			expect(typeof handle.exports.test?.helper).toBe('function');
		});
	});

	describe('closeAll', () => {
		test('closes all open documents', async () => {
			const { documents } = setup();

			const handle1 = await documents.open('f1');
			const handle2 = await documents.open('f2');

			await documents.closeAll();

			// Re-opening should create new Y.Doc instances
			const handle1b = await documents.open('f1');
			const handle2b = await documents.open('f2');
			expect(handle1b.ydoc).not.toBe(handle1.ydoc);
			expect(handle2b.ydoc).not.toBe(handle2.ydoc);
		});
	});

	describe('row deletion', () => {
		test('default onRowDeleted calls close', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const handle1 = await documents.open('f1');
			tables.files.delete('f1');

			// After deletion, re-opening should create a new Y.Doc
			const handle2 = await documents.open('f1');
			expect(handle2.ydoc).not.toBe(handle1.ydoc);
		});

		test('custom onRowDeleted fires with the guid', async () => {
			let deletedGuid = '';
			const { tables } = setupTables();

			const documents = createDocuments({
				guidKey: 'id',
				onUpdate: () => ({ updatedAt: Date.now() }),
				tableHelper: tables.files,
				ydoc: new Y.Doc({ guid: 'test' }),
				onRowDeleted: (_documents, guid) => {
					deletedGuid = guid;
				},
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			await documents.open('f1');
			tables.files.delete('f1');

			expect(deletedGuid).toBe('f1');
		});
	});

	describe('document extension hooks', () => {
		test('hooks are called in order', async () => {
			const order: number[] = [];

			const { documents } = setup({
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

			await documents.open('f1');
			expect(order).toEqual([1, 2, 3]);
		});

		test('second hook receives whenReady from first', async () => {
			let secondReceivedWhenReady = false;

			const { documents } = setup({
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

			await documents.open('f1');
			expect(secondReceivedWhenReady).toBe(true);
		});

		test('hook returning void is skipped', async () => {
			let hooksCalled = 0;

			const { documents } = setup({
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

			await documents.open('f1');
			expect(hooksCalled).toBe(2);
		});

		test('no hooks → bare handle with Y.Doc, instant resolution', async () => {
			const { documents } = setup({ documentExtensions: [] });

			const handle = await documents.open('f1');
			expect(handle.ydoc).toBeInstanceOf(Y.Doc);
		});

		test('tag matching: extension with no tags fires for all documents', async () => {
			let called = false;
			const { documents } = setup({
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

			await documents.open('f1');
			expect(called).toBe(true);
		});

		test('tag matching: extension with matching tag fires', async () => {
			let called = false;
			const { documents } = setup({
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

			await documents.open('f1');
			expect(called).toBe(true);
		});

		test('tag matching: extension with non-matching tag does NOT fire', async () => {
			let called = false;
			const { documents } = setup({
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

			await documents.open('f1');
			expect(called).toBe(false);
		});

		test('tag matching: doc with no tags only gets universal extensions', async () => {
			const calls: string[] = [];
			const { documents } = setup({
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

			await documents.open('f1');
			expect(calls).toEqual(['universal']);
		});
	});

	describe('document extension whenReady and typed extensions', () => {
		test('document extension receives extensions map with flat exports', async () => {
			let capturedFirstExtension: unknown;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							someValue: 42,
							destroy: () => {},
						}),
						tags: [],
					},
					{
						key: 'second',
						factory: (context) => {
							capturedFirstExtension = context.extensions.first;
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await documents.open('f1');
			expect(capturedFirstExtension).toBeDefined();
			expect(
				(capturedFirstExtension as Record<string, unknown>).someValue,
			).toBe(42);
		});

		test('document extension extensions map is optional (tag filtering may skip)', async () => {
			let taggedPresentForPersistentDoc = false;
			let taggedPresentForEphemeralDoc = true;

			const persistentSetup = setup({
				documentTags: ['persistent'],
				documentExtensions: [
					{
						key: 'tagged',
						factory: () => ({
							label: 'tagged',
							destroy: () => {},
						}),
						tags: ['persistent'],
					},
					{
						key: 'universal',
						factory: (context) => {
							taggedPresentForPersistentDoc =
								context.extensions.tagged !== undefined;
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await persistentSetup.documents.open('f1');

			const ephemeralSetup = setup({
				documentTags: ['ephemeral'],
				documentExtensions: [
					{
						key: 'tagged',
						factory: () => ({
							label: 'tagged',
							destroy: () => {},
						}),
						tags: ['persistent'],
					},
					{
						key: 'universal',
						factory: (context) => {
							taggedPresentForEphemeralDoc =
								context.extensions.tagged !== undefined;
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await ephemeralSetup.documents.open('f1');

			expect(taggedPresentForPersistentDoc).toBe(true);
			expect(taggedPresentForEphemeralDoc).toBe(false);
		});

		test('document extension with no exports is still accessible', async () => {
			let firstExtensionSeen = false;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							destroy: () => {},
						}),
						tags: [],
					},
					{
						key: 'second',
						factory: (context) => {
							firstExtensionSeen = context.extensions.first !== undefined;
							return { destroy: () => {} };
						},
						tags: [],
					},
				],
			});

			await documents.open('f1');
			expect(firstExtensionSeen).toBe(true);
		});

		test('handle.exports includes flat exports from extensions', async () => {
			const { documents } = setup({
				documentExtensions: [
					{
						key: 'test',
						factory: () => ({
							helper: () => 42,
							destroy: () => {},
						}),
						tags: [],
					},
				],
			});

			const handle = await documents.open('f1');
			expect(handle.exports).toBeDefined();
			if (!handle.exports.test) {
				throw new Error('Expected exports for test extension');
			}
			expect(typeof handle.exports.test.helper).toBe('function');
		});
	});
});
