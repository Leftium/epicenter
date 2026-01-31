/**
 * Batch Operation Tests
 *
 * Tests to verify that batch() properly wraps operations in a Y.js transaction.
 *
 * Expected behavior when batch() uses ydoc.transact():
 * - Observers fire ONCE at the end of the batch (not per operation)
 * - All changes are sent as a single update to sync peers
 * - Operations within batch can read values set earlier in the same batch
 *
 * Current issue: batch() doesn't actually use ydoc.transact(), so observers
 * fire per-operation instead of once at the end.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { id, integer, text } from '../core/schema/fields/factories';
import { createWorkspace } from './create-workspace';
import type { TableDef } from './types';

const testTable: TableDef = {
	id: 'items',
	name: 'Items',
	description: 'Test items',
	icon: null,
	fields: [
		{ id: 'id', type: 'id', name: 'ID' },
		{ id: 'title', type: 'text', name: 'Title' },
		{ id: 'count', type: 'integer', name: 'Count' },
	],
};

const testDefinition = {
	id: 'test-workspace',
	name: 'Test Workspace',
	description: 'For testing batch operations',
	icon: null,
	tables: [testTable] as const,
	kv: [],
};

describe('batch() operation', () => {
	test('batch should wrap operations in a single Y.js transaction', () => {
		const client = createWorkspace({
			id: 'batch-test-1',
			definition: testDefinition,
		}).withExtensions({});

		const table = client.table('items');
		let observerCallCount = 0;

		// Set up observer
		const unsubscribe = table.observe(() => {
			observerCallCount++;
		});

		// Perform multiple operations in a batch
		client.batch((ws) => {
			const t = ws.table('items');
			t.setCell('row1', 'title', 'Item 1');
			t.setCell('row1', 'count', 10);
			t.setCell('row2', 'title', 'Item 2');
			t.setCell('row2', 'count', 20);
		});

		unsubscribe();

		// If batch properly wraps in transact(), observer should fire ONCE
		// If batch doesn't wrap, observer fires per-operation (4 times)
		console.log(`Observer fired ${observerCallCount} times`);

		// This is what we WANT (once batch is fixed)
		expect(observerCallCount).toBe(1);
	});

	test('values set in batch should be readable within the same batch', () => {
		const client = createWorkspace({
			id: 'batch-test-2',
			definition: testDefinition,
		}).withExtensions({});

		const table = client.table('items');

		let valueReadInBatch: unknown;

		client.batch((ws) => {
			const t = ws.table('items');
			t.setCell('row1', 'title', 'Hello');
			// Should be able to read value set earlier in same batch
			const result = t.getCell('row1', 'title');
			// Dynamic API uses 'valid' status, not 'ok'
			valueReadInBatch = result.status === 'valid' ? result.value : undefined;
		});

		expect(valueReadInBatch).toBe('Hello');
	});

	test('batch operations should be atomic for observers', () => {
		const client = createWorkspace({
			id: 'batch-test-3',
			definition: testDefinition,
		}).withExtensions({});

		const table = client.table('items');
		const observedChanges: string[] = [];

		const unsubscribe = table.observe((events) => {
			// Each callback should see ALL changes from the batch
			for (const event of events) {
				observedChanges.push(event.key);
			}
		});

		client.batch((ws) => {
			const t = ws.table('items');
			t.setCell('row1', 'title', 'A');
			t.setCell('row2', 'title', 'B');
			t.setCell('row3', 'title', 'C');
		});

		unsubscribe();

		console.log('Observed changes:', observedChanges);

		// If properly batched, we should see all 3 changes in a single observer call
		// The exact behavior depends on implementation, but we should have all 3 keys
		expect(observedChanges).toContain('row1:title');
		expect(observedChanges).toContain('row2:title');
		expect(observedChanges).toContain('row3:title');
	});

	test('comparing batch vs non-batch observer behavior', () => {
		const client = createWorkspace({
			id: 'batch-test-4',
			definition: testDefinition,
		}).withExtensions({});

		const table = client.table('items');

		// Test 1: Without batch
		let nonBatchCallCount = 0;
		const unsub1 = table.observe(() => {
			nonBatchCallCount++;
		});

		table.setCell('a', 'title', '1');
		table.setCell('b', 'title', '2');
		table.setCell('c', 'title', '3');

		unsub1();

		// Test 2: With batch
		let batchCallCount = 0;
		const unsub2 = table.observe(() => {
			batchCallCount++;
		});

		client.batch((ws) => {
			const t = ws.table('items');
			t.setCell('d', 'title', '4');
			t.setCell('e', 'title', '5');
			t.setCell('f', 'title', '6');
		});

		unsub2();

		console.log(
			`Non-batch operations: observer called ${nonBatchCallCount} times`,
		);
		console.log(`Batch operations: observer called ${batchCallCount} times`);

		// Without batch: 3 calls (one per operation)
		// With proper batch: 1 call
		expect(nonBatchCallCount).toBe(3);
		expect(batchCallCount).toBe(1); // This will FAIL until batch is fixed
	});
});

describe('YKeyValueLww pending behavior', () => {
	test('YKeyValueLww get() returns value set in same transaction', async () => {
		const { YKeyValueLww } = await import('../core/utils/y-keyvalue-lww');
		const Y = await import('yjs');

		const ydoc = new Y.Doc({ guid: 'ykv-test' });
		const yarray = ydoc.getArray<{ key: string; val: string; ts: number }>(
			'data',
		);
		const kv = new YKeyValueLww(yarray);

		let valueInTransaction: string | undefined;

		ydoc.transact(() => {
			kv.set('foo', 'bar');
			valueInTransaction = kv.get('foo');
		});

		console.log('YKeyValueLww - value in transaction:', valueInTransaction);
		expect(valueInTransaction).toBe('bar');
		expect(kv.get('foo')).toBe('bar');
	});

	test('TableHelper getCell via rawGet uses ykv.get()', async () => {
		const client = createWorkspace({
			id: 'table-helper-test',
			definition: testDefinition,
		}).withExtensions({});

		const table = client.table('items');

		// First verify direct access works
		table.setCell('test1', 'title', 'Direct');
		const directResult = table.getCell('test1', 'title');
		console.log('Direct (no transaction) getCell result:', directResult);

		// Now test inside transaction
		let valueInBatch: unknown;
		let hasInBatch: boolean = false;

		client.ydoc.transact(() => {
			table.setCell('test2', 'title', 'InTransaction');
			hasInBatch = table.hasCell('test2', 'title');
			const result = table.getCell('test2', 'title');
			console.log(
				'In transaction - hasCell:',
				hasInBatch,
				'getCell result:',
				result,
			);
			// Dynamic API uses 'valid' status, not 'ok'
			valueInBatch = result.status === 'valid' ? result.value : result.status;
		});

		console.log('After transaction - valueInBatch:', valueInBatch);
		expect(valueInBatch).toBe('InTransaction');
	});
});

describe('direct ydoc.transact() for comparison', () => {
	test('ydoc.transact() should batch observer calls', () => {
		const client = createWorkspace({
			id: 'transact-test',
			definition: testDefinition,
		}).withExtensions({});

		const table = client.table('items');
		let observerCallCount = 0;

		const unsubscribe = table.observe(() => {
			observerCallCount++;
		});

		// Use ydoc.transact() directly to verify the underlying mechanism works
		client.ydoc.transact(() => {
			table.setCell('row1', 'title', 'A');
			table.setCell('row2', 'title', 'B');
			table.setCell('row3', 'title', 'C');
		});

		unsubscribe();

		console.log(`Direct transact: observer called ${observerCallCount} times`);

		// This should work because YKeyValueLww was fixed
		expect(observerCallCount).toBe(1);
	});
});
