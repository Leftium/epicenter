import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	createGridWorkspace,
	createWorkspaceYDoc,
} from './create-grid-workspace';
import type { GridWorkspaceDefinition } from './types';

// Test definition
const testDefinition: GridWorkspaceDefinition = {
	name: 'Test Workspace',
	description: 'A test workspace',
	icon: null,
	tables: [
		{
			id: 'posts',
			name: 'Posts',
			description: 'Blog posts',
			icon: null,
			fields: [
				{ id: 'id', name: 'ID', type: 'id', description: '', icon: null },
				{
					id: 'title',
					name: 'Title',
					type: 'text',
					description: '',
					icon: null,
				},
				{
					id: 'views',
					name: 'Views',
					type: 'integer',
					description: '',
					icon: null,
				},
			],
		},
	],
	kv: [],
};

describe('createWorkspaceYDoc', () => {
	test('creates Y.Doc with plain GUID when no HeadDoc', () => {
		const ydoc = createWorkspaceYDoc('test-workspace');
		expect(ydoc.guid).toBe('test-workspace');
		expect(ydoc.gc).toBe(true); // GC enabled by default
	});

	test('creates Y.Doc with epoch-suffixed GUID when HeadDoc present', () => {
		const mockHeadDoc = { getEpoch: () => 5 };
		const ydoc = createWorkspaceYDoc('test-workspace', mockHeadDoc);
		expect(ydoc.guid).toBe('test-workspace-5');
		expect(ydoc.gc).toBe(false); // GC disabled for snapshots
	});
});

describe('createGridWorkspace', () => {
	test('creates workspace without HeadDoc (simple mode)', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		expect(client.id).toBe('test-workspace');
		expect(client.epoch).toBe(0);
		expect(client.ydoc.guid).toBe('test-workspace');
		expect(client.name).toBe('Test Workspace');
		expect(client.description).toBe('A test workspace');
	});

	test('creates workspace with HeadDoc (full mode)', () => {
		const mockHeadDoc = {
			workspaceId: 'test-workspace',
			getEpoch: () => 3,
		};

		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
			headDoc: mockHeadDoc,
		}).withExtensions({});

		expect(client.id).toBe('test-workspace');
		expect(client.epoch).toBe(3);
		expect(client.ydoc.guid).toBe('test-workspace-3');
		expect(client.ydoc.gc).toBe(false);
	});

	test('uses existing Y.Doc when provided', () => {
		const existingYdoc = new Y.Doc({ guid: 'custom-guid' });

		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
			ydoc: existingYdoc,
		}).withExtensions({});

		expect(client.ydoc).toBe(existingYdoc);
		expect(client.ydoc.guid).toBe('custom-guid');
	});
});

describe('GridTableHelper', () => {
	test('creates and gets cells', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		const posts = client.table('posts');

		// Set cells
		posts.setCell('row1', 'title', 'Hello World');
		posts.setCell('row1', 'views', 100);

		// Get cells
		const titleResult = posts.getCell('row1', 'title');
		expect(titleResult.status).toBe('valid');
		if (titleResult.status === 'valid') {
			expect(titleResult.value).toBe('Hello World');
		}

		const viewsResult = posts.getCell('row1', 'views');
		expect(viewsResult.status).toBe('valid');
		if (viewsResult.status === 'valid') {
			expect(viewsResult.value).toBe(100);
		}
	});

	test('createRow with options sets initial cells', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		const posts = client.table('posts');

		const rowId = posts.createRow({
			id: 'custom-id',
			cells: {
				title: 'My Post',
				views: 50,
			},
		});

		expect(rowId).toBe('custom-id');

		const row = posts.getRow('custom-id');
		expect(row.status).toBe('valid');
		if (row.status === 'valid') {
			expect(row.row.cells.title).toBe('My Post');
			expect(row.row.cells.views).toBe(50);
		}
	});

	test('setRow replaces all cells', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		const posts = client.table('posts');

		// Set initial cells
		posts.setCell('row1', 'title', 'Original');
		posts.setCell('row1', 'views', 10);
		posts.setCell('row1', 'extra', 'will be deleted');

		// Replace with setRow
		posts.setRow('row1', { title: 'New Title', views: 20 });

		const row = posts.getRow('row1');
		expect(row.status).toBe('valid');
		if (row.status === 'valid') {
			expect(row.row.cells.title).toBe('New Title');
			expect(row.row.cells.views).toBe(20);
			expect(row.row.cells.extra).toBeUndefined();
		}
	});

	test('getAllValid returns only valid rows', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		const posts = client.table('posts');

		// Valid row
		posts.setCell('row1', 'title', 'Valid Post');
		posts.setCell('row1', 'views', 10);

		// Invalid row (views should be integer)
		posts.setCell('row2', 'title', 'Invalid Post');
		posts.setCell('row2', 'views', 'not a number');

		const validRows = posts.getAllValid();
		expect(validRows.length).toBe(1);
		expect(validRows[0]?.id).toBe('row1');
	});

	test('deleteRow removes all cells for a row', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		const posts = client.table('posts');

		posts.setCell('row1', 'title', 'To Delete');
		posts.setCell('row1', 'views', 5);

		expect(posts.hasCell('row1', 'title')).toBe(true);

		posts.deleteRow('row1');

		expect(posts.hasCell('row1', 'title')).toBe(false);
		expect(posts.hasCell('row1', 'views')).toBe(false);

		const row = posts.getRow('row1');
		expect(row.status).toBe('not_found');
	});
});

describe('GridKvStore', () => {
	test('sets and gets values', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		client.kv.set('theme', 'dark');
		expect(client.kv.get('theme')).toBe('dark');
		expect(client.kv.has('theme')).toBe(true);
	});

	test('deletes values', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		client.kv.set('theme', 'dark');
		client.kv.delete('theme');
		expect(client.kv.has('theme')).toBe(false);
	});

	test('getAll returns all key-value pairs', () => {
		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({});

		client.kv.set('theme', 'dark');
		client.kv.set('fontSize', 14);

		const all = client.kv.getAll();
		expect(all.get('theme')).toBe('dark');
		expect(all.get('fontSize')).toBe(14);
	});
});

describe('Extensions', () => {
	test('extensions receive correct context', () => {
		let receivedContext: unknown;

		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({
			testExtension: (ctx) => {
				receivedContext = ctx;
				return {
					whenSynced: Promise.resolve(),
					destroy: async () => {},
					testValue: 42,
				};
			},
		});

		const ctx = receivedContext as {
			workspaceId: string;
			epoch: number;
			extensionId: string;
		};

		expect(ctx.workspaceId).toBe('test-workspace');
		expect(ctx.epoch).toBe(0);
		expect(ctx.extensionId).toBe('testExtension');
		expect(client.extensions.testExtension.testValue).toBe(42);
	});

	test('destroy calls extension destroy methods', async () => {
		let destroyed = false;

		const client = createGridWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		}).withExtensions({
			testExtension: () => ({
				whenSynced: Promise.resolve(),
				destroy: async () => {
					destroyed = true;
				},
			}),
		});

		await client.destroy();
		expect(destroyed).toBe(true);
	});
});
