/**
 * createDocumentBinding Tests
 *
 * Validates document binding lifecycle, read/write behavior, and integration with table row metadata.
 * The suite protects contracts around open/read/write idempotency, cleanup semantics, and hook orchestration.
 *
 * Key behaviors:
 * - Document operations keep row metadata in sync and honor binding origins.
 * - Lifecycle methods (`destroy`, `purge`, `destroyAll`) safely clean up open docs.
 */

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
	overrides?: Partial<Parameters<typeof createDocumentBinding>[0]>,
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

		test('open accepts a row object and resolves guid', async () => {
			const { tables, binding } = setupWithBinding();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			};
			tables.files.set(row);

			const doc = await binding.open(row);
			expect(doc.guid).toBe('f1');
		});

		test('open accepts a string guid directly', async () => {
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
	});

	describe('destroy', () => {
		test('frees memory — doc can be re-opened as new instance', async () => {
			const { binding } = setupWithBinding();

			const doc1 = await binding.open('f1');
			await binding.destroy('f1');

			const doc2 = await binding.open('f1');
			expect(doc2).not.toBe(doc1);
		});

		test('destroy on non-existent guid is a no-op', async () => {
			const { binding } = setupWithBinding();

			// Should not throw
			await binding.destroy('nonexistent');
		});
	});

	describe('purge', () => {
		test('calls clearData on providers that support it', async () => {
			let clearDataCalled = false;
			const { tables, binding } = setupWithBinding({
				onDocumentOpen: [
					() => ({
						destroy: () => {},
						clearData: () => {
							clearDataCalled = true;
						},
					}),
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
				onDocumentOpen: [
					() => ({
						destroy: () => {
							destroyCalled = true;
						},
						// no clearData
					}),
				],
			});

			await binding.open('f1');
			await binding.purge('f1');

			expect(destroyCalled).toBe(true);
		});

		test('purge opens doc if not already open', async () => {
			let openedByPurge = false;
			const { binding } = setupWithBinding({
				onDocumentOpen: [
					() => {
						openedByPurge = true;
						return {
							destroy: () => {},
							clearData: () => {},
						};
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
			let deletedGuid: string | null = null;
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
				_v: 1,
			};
			expect(binding.guidOf(row)).toBe('f1');
		});

		test('updatedAtOf extracts the updatedAt column value', () => {
			const { binding } = setupWithBinding();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 456,
				_v: 1,
			};
			expect(binding.updatedAtOf(row)).toBe(456);
		});
	});

	describe('onDocumentOpen hooks', () => {
		test('hooks are called in order', async () => {
			const order: number[] = [];

			const { binding } = setupWithBinding({
				onDocumentOpen: [
					() => {
						order.push(1);
						return { destroy: () => {} };
					},
					() => {
						order.push(2);
						return { destroy: () => {} };
					},
					() => {
						order.push(3);
						return { destroy: () => {} };
					},
				],
			});

			await binding.open('f1');
			expect(order).toEqual([1, 2, 3]);
		});

		test('second hook receives whenReady from first', async () => {
			let secondReceivedWhenReady = false;

			const { binding } = setupWithBinding({
				onDocumentOpen: [
					() => ({
						whenReady: Promise.resolve(),
						destroy: () => {},
					}),
					({ whenReady }) => {
						secondReceivedWhenReady = whenReady instanceof Promise;
						return { destroy: () => {} };
					},
				],
			});

			await binding.open('f1');
			expect(secondReceivedWhenReady).toBe(true);
		});

		test('hook returning void is skipped', async () => {
			let hooksCalled = 0;

			const { binding } = setupWithBinding({
				onDocumentOpen: [
					() => {
						hooksCalled++;
						return undefined; // void return
					},
					() => {
						hooksCalled++;
						return { destroy: () => {} };
					},
				],
			});

			await binding.open('f1');
			expect(hooksCalled).toBe(2);
		});

		test('no hooks → bare Y.Doc, instant resolution', async () => {
			const { binding } = setupWithBinding({ onDocumentOpen: [] });

			const doc = await binding.open('f1');
			expect(doc).toBeInstanceOf(Y.Doc);
		});

		test('hook receives correct binding metadata', async () => {
			let capturedBinding: { tableName: string; documentName: string } | null =
				null;

			const { ydoc, tables } = setup();
			const binding = createDocumentBinding({
				guidKey: 'id',
				updatedAtKey: 'updatedAt',
				tableHelper: tables.files,
				ydoc,
				tableName: 'files',
				documentName: 'content',
				onDocumentOpen: [
					(ctx) => {
						capturedBinding = ctx.binding;
						return { destroy: () => {} };
					},
				],
			});

			await binding.open('f1');
			expect(capturedBinding).toEqual({
				tableName: 'files',
				documentName: 'content',
			});
		});
	});
});
