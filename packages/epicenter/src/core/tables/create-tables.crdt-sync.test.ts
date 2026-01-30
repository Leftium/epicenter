import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { boolean, id, integer, table, text } from '../schema';
import { createTables } from './create-tables';

describe('Cell-Level CRDT Merging', () => {
	test('concurrent edits to different columns merge correctly', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tables1 = createTables(doc1, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		const tables2 = createTables(doc2, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		tables1.get('posts').upsert({
			id: 'post-1',
			title: 'Original',
			views: 0,
			published: false,
		});

		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		const row1Before = tables1.get('posts').get('post-1');
		const row2Before = tables2.get('posts').get('post-1');
		expect(row1Before.status).toBe('valid');
		expect(row2Before.status).toBe('valid');
		if (row1Before.status === 'valid' && row2Before.status === 'valid') {
			expect(row1Before.row.title).toBe('Original');
			expect(row2Before.row.title).toBe('Original');
		}

		tables1.get('posts').update({ id: 'post-1', title: 'Updated by User 1' });
		tables2.get('posts').update({ id: 'post-1', views: 100 });

		const row1Mid = tables1.get('posts').get('post-1');
		const row2Mid = tables2.get('posts').get('post-1');
		expect(row1Mid.status).toBe('valid');
		expect(row2Mid.status).toBe('valid');
		if (row1Mid.status === 'valid') {
			expect(row1Mid.row.title).toBe('Updated by User 1');
			expect(row1Mid.row.views).toBe(0);
		}
		if (row2Mid.status === 'valid') {
			expect(row2Mid.row.title).toBe('Original');
			expect(row2Mid.row.views).toBe(100);
		}

		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		const row1After = tables1.get('posts').get('post-1');
		const row2After = tables2.get('posts').get('post-1');

		expect(row1After.status).toBe('valid');
		expect(row2After.status).toBe('valid');

		if (row1After.status === 'valid' && row2After.status === 'valid') {
			expect(row1After.row.title).toBe('Updated by User 1');
			expect(row1After.row.views).toBe(100);
			expect(row2After.row.title).toBe('Updated by User 1');
			expect(row2After.row.views).toBe(100);
		}
	});

	test('concurrent edits to same column use LWW', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tables1 = createTables(doc1, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);
		const tables2 = createTables(doc2, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		tables1.get('posts').upsert({ id: 'post-1', title: 'Original' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		tables1.get('posts').update({ id: 'post-1', title: 'User 1 Title' });
		tables2.get('posts').update({ id: 'post-1', title: 'User 2 Title' });

		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		const row1 = tables1.get('posts').get('post-1');
		const row2 = tables2.get('posts').get('post-1');

		expect(row1.status).toBe('valid');
		expect(row2.status).toBe('valid');
		if (row1.status === 'valid' && row2.status === 'valid') {
			expect(row1.row.title).toBe(row2.row.title);
		}
	});

	test('same-column conflicts: winner varies by client ID (demonstrates unpredictability)', () => {
		/**
		 * This test demonstrates that same-column concurrent edits have
		 * unpredictable winners based on Yjs's internal ordering.
		 *
		 * The winner depends on client IDs and CRDT merge order, NOT timestamps.
		 * This is acceptable because:
		 * 1. Cell-level CRDTs make same-column conflicts rare
		 * 2. Both clients always converge to the same value
		 *
		 * If predictable "last write wins" is needed, timestamps can be added.
		 */
		const winners: string[] = [];

		for (let i = 0; i < 10; i++) {
			const doc1 = new Y.Doc();
			const doc2 = new Y.Doc();

			const tables1 = createTables(doc1, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);
			const tables2 = createTables(doc2, [
				table({
					id: 'posts',
					name: '',
					fields: [id(), text({ id: 'title' })] as const,
				}),
			]);

			tables1.get('posts').upsert({ id: 'post-1', title: 'Original' });
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

			tables1
				.get('posts')
				.update({ id: 'post-1', title: `Iteration ${i} User 1` });
			tables2
				.get('posts')
				.update({ id: 'post-1', title: `Iteration ${i} User 2` });

			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

			const row1 = tables1.get('posts').get('post-1');
			const row2 = tables2.get('posts').get('post-1');

			expect(row1.status).toBe('valid');
			expect(row2.status).toBe('valid');

			if (row1.status === 'valid' && row2.status === 'valid') {
				expect(row1.row.title).toBe(row2.row.title);
				winners.push(row1.row.title.includes('User 1') ? 'User 1' : 'User 2');
			}
		}

		console.log('Same-column conflict winners:', winners);
	});

	test('partial updates preserve unmentioned fields', () => {
		const ydoc = new Y.Doc({ guid: 'test' });
		const tables = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		]);

		tables.get('posts').upsert({
			id: 'post-1',
			title: 'Original Title',
			views: 50,
			published: true,
		});

		tables.get('posts').update({ id: 'post-1', title: 'New Title' });

		const result = tables.get('posts').get('post-1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('New Title');
			expect(result.row.views).toBe(50);
			expect(result.row.published).toBe(true);
		}
	});

	test('three-way merge: three docs editing different columns simultaneously', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		const doc3 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;
		doc3.clientID = 3;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);
		const tables3 = createTables(doc3, tableDefinitions);

		// Initial state
		tables1.get('posts').upsert({
			id: 'post-1',
			title: 'Original',
			views: 0,
			published: false,
		});

		// Sync to all docs
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc3, Y.encodeStateAsUpdate(doc1));

		// Each doc edits a different column concurrently
		tables1.get('posts').update({ id: 'post-1', title: 'Title by User 1' });
		tables2.get('posts').update({ id: 'post-1', views: 100 });
		tables3.get('posts').update({ id: 'post-1', published: true });

		// Full sync: all docs exchange updates
		const update1 = Y.encodeStateAsUpdate(doc1);
		const update2 = Y.encodeStateAsUpdate(doc2);
		const update3 = Y.encodeStateAsUpdate(doc3);

		Y.applyUpdate(doc1, update2);
		Y.applyUpdate(doc1, update3);
		Y.applyUpdate(doc2, update1);
		Y.applyUpdate(doc2, update3);
		Y.applyUpdate(doc3, update1);
		Y.applyUpdate(doc3, update2);

		// All three docs should have all three changes
		for (const tables of [tables1, tables2, tables3]) {
			const result = tables.get('posts').get('post-1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.title).toBe('Title by User 1');
				expect(result.row.views).toBe(100);
				expect(result.row.published).toBe(true);
			}
		}
	});

	test('interleaved sync: partial syncs between edits', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Initial state
		tables1.get('posts').upsert({
			id: 'post-1',
			title: 'Original',
			views: 0,
			published: false,
		});
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// A edits title
		tables1.get('posts').update({ id: 'post-1', title: 'Edit 1 by A' });

		// Partial sync: A -> B only
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// B edits views (after receiving A's title change)
		tables2.get('posts').update({ id: 'post-1', views: 50 });

		// A edits title again (hasn't received B's views yet)
		tables1.get('posts').update({ id: 'post-1', title: 'Edit 2 by A' });

		// Full sync
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Both should have A's second title edit and B's views
		for (const tables of [tables1, tables2]) {
			const result = tables.get('posts').get('post-1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.title).toBe('Edit 2 by A');
				expect(result.row.views).toBe(50);
			}
		}
	});

	test('delete during concurrent edit: one doc deletes row while another edits it', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		tables1.get('posts').upsert({
			id: 'post-1',
			title: 'Original',
			views: 0,
		});
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		tables1.get('posts').delete('post-1');
		tables2.get('posts').update({ id: 'post-1', title: 'Updated Title' });

		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		const result1 = tables1.get('posts').get('post-1');
		const result2 = tables2.get('posts').get('post-1');

		// With Y.Map delete semantics, delete wins over concurrent updates
		// because the row's Y.Array is removed from the table Y.Map.
		// Doc2's update modified cells within the Y.Array, but doc1's
		// delete removed the entire Y.Array from the table Y.Map.
		// After sync, both see the row as deleted.
		expect(result1.status).toBe('not_found');
		expect(result2.status).toBe('not_found');
	});

	test('upsert vs update race: one doc upserts new row while another tries to update same ID', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// No initial sync - docs start empty

		// Doc1 upserts a new row
		tables1.get('posts').upsert({
			id: 'post-1',
			title: 'Created by Doc1',
			views: 10,
		});

		// Doc2 tries to update a row with same ID (doesn't exist locally)
		const updateResult = tables2.get('posts').update({
			id: 'post-1',
			title: 'Updated by Doc2',
		});

		// Update should be a no-op since row doesn't exist locally
		expect(updateResult.status).toBe('not_found_locally');

		// Doc2 row should still not exist
		expect(tables2.get('posts').get('post-1').status).toBe('not_found');

		// After sync, doc2 should see doc1's row
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		const result = tables2.get('posts').get('post-1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Created by Doc1');
			expect(result.row.views).toBe(10);
		}
	});

	test('multiple rows concurrent: edits to different rows should be independent', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Create two rows
		tables1.get('posts').upsert({ id: 'post-1', title: 'Post 1', views: 0 });
		tables1.get('posts').upsert({ id: 'post-2', title: 'Post 2', views: 0 });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Doc1 edits post-1, doc2 edits post-2
		tables1.get('posts').update({ id: 'post-1', title: 'Post 1 Edited' });
		tables2.get('posts').update({ id: 'post-2', title: 'Post 2 Edited' });

		// Sync
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		// Both rows should have their respective edits
		for (const tables of [tables1, tables2]) {
			const result1 = tables.get('posts').get('post-1');
			const result2 = tables.get('posts').get('post-2');

			expect(result1.status).toBe('valid');
			expect(result2.status).toBe('valid');

			if (result1.status === 'valid' && result2.status === 'valid') {
				expect(result1.row.title).toBe('Post 1 Edited');
				expect(result2.row.title).toBe('Post 2 Edited');
			}
		}
	});

	test('observer fires correctly during sync: add events', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Set up observer on doc2 BEFORE any sync
		const addedIds: string[] = [];
		tables2.get('posts').observe((changedIds) => {
			for (const id of changedIds) {
				const result = tables2.get('posts').get(id);
				if (result.status !== 'not_found') {
					// Could be add or update - we only care about new rows here
					// Since we're tracking before any sync, these are all adds
					addedIds.push(id);
				}
			}
		});

		// Create row on doc1
		tables1.get('posts').upsert({ id: 'post-1', title: 'Created on Doc1' });

		// Sync to doc2 - observer should fire 'add'
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		expect(addedIds).toContain('post-1');
	});

	test('observer fires correctly during sync: update events', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Create row and sync
		tables1.get('posts').upsert({ id: 'post-1', title: 'Original', views: 0 });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Set up observer on doc2
		const updatedIds: string[] = [];
		tables2.get('posts').observe((changedIds) => {
			for (const id of changedIds) {
				const result = tables2.get('posts').get(id);
				if (result.status !== 'not_found') {
					// Row exists, so it was added or updated
					updatedIds.push(id);
				}
			}
		});

		// Update on doc1
		tables1.get('posts').update({ id: 'post-1', title: 'Modified' });

		// Sync to doc2 - observer should fire 'update'
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		expect(updatedIds).toContain('post-1');
	});

	test('observer fires correctly during sync: delete events', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Create row and sync
		tables1.get('posts').upsert({ id: 'post-1', title: 'To be deleted' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Set up observer on doc2
		const deletedIds: string[] = [];
		tables2.get('posts').observe((changedIds) => {
			for (const id of changedIds) {
				const result = tables2.get('posts').get(id);
				if (result.status === 'not_found') {
					// Row was deleted
					deletedIds.push(id);
				}
			}
		});

		// Delete on doc1
		tables1.get('posts').delete('post-1');

		// Sync to doc2 - observer should fire 'delete'
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		expect(deletedIds).toContain('post-1');
	});

	test('cache invalidation on sync: rowKVCache stays correct after receiving remote updates', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Create row on doc1 and sync
		tables1.get('posts').upsert({ id: 'post-1', title: 'Original', views: 0 });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Read on doc2 to populate cache
		const initialResult = tables2.get('posts').get('post-1');
		expect(initialResult.status).toBe('valid');
		if (initialResult.status === 'valid') {
			expect(initialResult.row.title).toBe('Original');
		}

		// Update on doc1
		tables1.get('posts').update({ id: 'post-1', title: 'Updated by Doc1' });

		// Sync to doc2
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Read from doc2 cache - should see updated value
		const updatedResult = tables2.get('posts').get('post-1');
		expect(updatedResult.status).toBe('valid');
		if (updatedResult.status === 'valid') {
			expect(updatedResult.row.title).toBe('Updated by Doc1');
		}
	});

	test('concurrent upserts of same row create consistent result', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
					boolean({ id: 'published' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		tables1.get('posts').upsert({
			id: 'post-1',
			title: 'Title from Doc1',
			views: 100,
			published: true,
		});
		tables2.get('posts').upsert({
			id: 'post-1',
			title: 'Title from Doc2',
			views: 200,
			published: false,
		});

		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

		const result1 = tables1.get('posts').get('post-1');
		const result2 = tables2.get('posts').get('post-1');

		expect(result1.status).toBe('valid');
		expect(result2.status).toBe('valid');

		if (result1.status === 'valid' && result2.status === 'valid') {
			// When both docs independently create the same row ID, each doc creates
			// its own table Y.Map and row Y.Array. YJS LWW determines which table
			// wins. This is NOT cell-level merging since the rows were created
			// independently (not from a common ancestor). Both docs converge to
			// whichever row "wins" via YJS LWW (based on client ID tie-breaking).
			// The key guarantee is consistency: both docs see the same final state.
			expect(result1.row).toEqual(result2.row);
		}
	});

	test('getAll returns correct data after sync with remote additions', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Doc1 creates multiple rows
		tables1.get('posts').upsert({ id: 'post-1', title: 'First' });
		tables1.get('posts').upsert({ id: 'post-2', title: 'Second' });
		tables1.get('posts').upsert({ id: 'post-3', title: 'Third' });

		// Sync to doc2
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// getAll on doc2 should return all 3 rows
		const allRows = tables2.get('posts').getAllValid();
		expect(allRows).toHaveLength(3);

		const titles = allRows.map((r) => r.title).sort();
		expect(titles).toEqual(['First', 'Second', 'Third']);
	});

	test('count stays correct after sync operations', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		// Doc1 creates rows
		tables1.get('posts').upsert({ id: 'post-1', title: 'One' });
		tables1.get('posts').upsert({ id: 'post-2', title: 'Two' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		expect(tables2.get('posts').count()).toBe(2);

		// Doc1 deletes one
		tables1.get('posts').delete('post-1');
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		expect(tables2.get('posts').count()).toBe(1);

		// Doc1 adds more
		tables1.get('posts').upsert({ id: 'post-3', title: 'Three' });
		tables1.get('posts').upsert({ id: 'post-4', title: 'Four' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		expect(tables2.get('posts').count()).toBe(3);
	});

	test('observer continues working after clear() and detects new rows', () => {
		// Tables are permanent structures; they can be emptied but never deleted.
		// This test verifies that clear() properly notifies observers and the
		// observer continues working for new rows.
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		tables1.get('posts').upsert({ id: 'post-1', title: 'First' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		const changes: Array<{ action: string; id: string }> = [];
		tables2.get('posts').observe((changedIds) => {
			for (const id of changedIds) {
				const result = tables2.get('posts').get(id);
				if (result.status === 'not_found') {
					changes.push({ action: 'delete', id });
				} else {
					changes.push({ action: 'add', id });
				}
			}
		});

		// Use clear() instead of deleting the table Y.Map directly
		tables2.get('posts').clear();

		expect(changes).toContainEqual({ action: 'delete', id: 'post-1' });

		// Add a new row; observer should still be working
		tables2.get('posts').upsert({ id: 'post-new', title: 'New Post' });

		expect(changes).toContainEqual({ action: 'add', id: 'post-new' });
	});

	test('observer receives updates from synced changes', () => {
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		doc1.clientID = 1;
		doc2.clientID = 2;

		const tableDefinitions = [
			table({
				id: 'posts',
				name: '',
				fields: [
					id(),
					text({ id: 'title' }),
					integer({ id: 'views' }),
				] as const,
			}),
		];

		const tables1 = createTables(doc1, tableDefinitions);
		const tables2 = createTables(doc2, tableDefinitions);

		tables1.get('posts').upsert({ id: 'post-1', title: 'Original', views: 0 });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		const changes: Array<{ action: string; id: string }> = [];
		tables2.get('posts').observe((changedIds) => {
			for (const id of changedIds) {
				const result = tables2.get('posts').get(id);
				if (result.status === 'not_found') {
					changes.push({ action: 'delete', id });
				} else {
					changes.push({ action: 'update', id });
				}
			}
		});

		tables1.get('posts').update({ id: 'post-1', title: 'Updated on Doc1' });
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		expect(changes).toContainEqual({ action: 'update', id: 'post-1' });

		const result = tables2.get('posts').get('post-1');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.row.title).toBe('Updated on Doc1');
		}
	});

	test('clear then upsertMany emits delete for old rows and add for new rows', () => {
		// Tables are permanent structures; to "replace" a table's contents,
		// use clear() followed by upsertMany(). This test verifies that
		// observers see deletions for old rows and additions for new rows.
		const ydoc = new Y.Doc({ guid: 'test-table-replacement' });

		const tables = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		tables.get('posts').upsertMany([
			{ id: 'old-1', title: 'Old Post 1' },
			{ id: 'old-2', title: 'Old Post 2' },
		]);

		const changes: Array<{ action: string; id: string }> = [];
		tables.get('posts').observe((changedIds) => {
			for (const rowId of changedIds) {
				const result = tables.get('posts').get(rowId);
				if (result.status === 'not_found') {
					changes.push({ action: 'delete', id: rowId });
				} else {
					changes.push({ action: 'add', id: rowId });
				}
			}
		});

		// Clear and add new rows (simulates "table replacement")
		tables.get('posts').clear();
		tables.get('posts').upsertMany([
			{ id: 'new-1', title: 'New Post 1' },
			{ id: 'new-2', title: 'New Post 2' },
		]);

		expect(changes).toContainEqual({ action: 'delete', id: 'old-1' });
		expect(changes).toContainEqual({ action: 'delete', id: 'old-2' });
		expect(changes).toContainEqual({ action: 'add', id: 'new-1' });
		expect(changes).toContainEqual({ action: 'add', id: 'new-2' });
	});

	test('row replacement emits update and continues observing new row', () => {
		const ydoc = new Y.Doc({ guid: 'test-row-replacement' });
		type RowMap = Y.Map<unknown>;
		type TableMap = Y.Map<RowMap>;
		type TablesMap = Y.Map<TableMap>;

		const ytables: TablesMap = ydoc.getMap('tables');

		const tables = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		tables.get('posts').upsert({ id: 'post-1', title: 'Original' });

		const changes: Array<{ action: string; id: string; title?: string }> = [];
		tables.get('posts').observe((changedIds) => {
			for (const rowId of changedIds) {
				const result = tables.get('posts').get(rowId);
				if (result.status === 'not_found') {
					changes.push({ action: 'delete', id: rowId });
				} else {
					const entry: { action: string; id: string; title?: string } = {
						action: 'update',
						id: rowId,
					};
					if (result.status === 'valid') {
						entry.title = result.row.title;
					}
					changes.push(entry);
				}
			}
		});

		const postsTable = ytables.get('posts')!;
		const replacementRow = new Y.Map() as RowMap;
		replacementRow.set('id', 'post-1');
		replacementRow.set('title', 'Replaced Row');
		postsTable.set('post-1', replacementRow);

		expect(changes).toContainEqual({
			action: 'update',
			id: 'post-1',
			title: 'Replaced Row',
		});

		changes.length = 0;

		replacementRow.set('title', 'Modified After Replacement');

		expect(
			changes.some((c) => c.id === 'post-1' && c.action === 'update'),
		).toBe(true);
	});

	test('table created after subscription with pre-existing rows emits adds', () => {
		const ydoc = new Y.Doc({ guid: 'test-late-table' });
		type RowMap = Y.Map<unknown>;
		type TableMap = Y.Map<RowMap>;
		type TablesMap = Y.Map<TableMap>;

		const ytables: TablesMap = ydoc.getMap('tables');

		const tables = createTables(ydoc, [
			table({
				id: 'posts',
				name: '',
				fields: [id(), text({ id: 'title' })] as const,
			}),
		]);

		const changes: Array<{ action: string; id: string }> = [];
		tables.get('posts').observe((changedIds) => {
			for (const rowId of changedIds) {
				const result = tables.get('posts').get(rowId);
				if (result.status === 'not_found') {
					changes.push({ action: 'delete', id: rowId });
				} else {
					changes.push({ action: 'add', id: rowId });
				}
			}
		});

		expect(ytables.has('posts')).toBe(false);

		const postsTable = new Y.Map() as TableMap;
		const row1 = new Y.Map() as RowMap;
		const row2 = new Y.Map() as RowMap;
		row1.set('id', 'existing-1');
		row1.set('title', 'Already Exists 1');
		row2.set('id', 'existing-2');
		row2.set('title', 'Already Exists 2');
		postsTable.set('existing-1', row1);
		postsTable.set('existing-2', row2);

		ytables.set('posts', postsTable);

		expect(changes).toContainEqual({ action: 'add', id: 'existing-1' });
		expect(changes).toContainEqual({ action: 'add', id: 'existing-2' });
	});
});
