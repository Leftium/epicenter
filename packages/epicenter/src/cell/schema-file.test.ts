import { describe, expect, test } from 'bun:test';
import { id, integer, text } from '../core/schema/fields/factories';
import {
	addField,
	addTable,
	createEmptySchema,
	getFieldById,
	getFieldIds,
	parseSchema,
	removeField,
	removeTable,
	stringifySchema,
} from './schema-file';
import type { SchemaTableDefinition, WorkspaceDefinition } from './types';

/**
 * Helper to create a table with array-based fields for cell workspace tests.
 * Simulates what would come from parsed JSON.
 */
function cellTable(
	tableId: string,
	options: {
		name: string;
		fields: SchemaTableDefinition['fields'];
		description?: string;
	},
): SchemaTableDefinition {
	return {
		id: tableId,
		name: options.name,
		description: options.description ?? '',
		icon: null,
		fields: options.fields,
	};
}

describe('parseSchema', () => {
	test('parses valid schema with Record fields (normalizes to array)', () => {
		const json = JSON.stringify({
			name: 'Test Workspace',
			icon: '📝',
			kv: {},
			tables: {
				posts: {
					name: 'Blog Posts',
					description: '',
					icon: null,
					fields: {
						id: id(),
						title: text({ id: 'title', name: 'Title' }),
						views: integer({ id: 'views', name: 'Views' }),
					},
				},
			},
		});

		const schema = parseSchema(json);
		expect(schema.name).toBe('Test Workspace');
		expect(schema.icon).toBe('emoji:📝');
		const postsTable = schema.tables.find((t) => t.id === 'posts');
		expect(postsTable).toBeDefined();
		expect(postsTable!.name).toBe('Blog Posts');
		// Fields are now an array
		expect(Array.isArray(postsTable!.fields)).toBe(true);
		expect(getFieldById(postsTable!, 'title')).toBeDefined();
		expect(getFieldIds(postsTable!)).toContain('title');
	});

	test('parses valid schema with Array fields', () => {
		const json = JSON.stringify({
			name: 'Test Workspace',
			icon: '📝',
			kv: {},
			tables: {
				posts: {
					name: 'Blog Posts',
					description: '',
					icon: null,
					fields: [
						id(),
						text({ id: 'title', name: 'Title' }),
						integer({ id: 'views', name: 'Views' }),
					],
				},
			},
		});

		const schema = parseSchema(json);
		expect(schema.name).toBe('Test Workspace');
		const postsTable = schema.tables.find((t) => t.id === 'posts');
		expect(postsTable).toBeDefined();
		expect(Array.isArray(postsTable!.fields)).toBe(true);
		expect(getFieldById(postsTable!, 'title')).toBeDefined();
		expect(getFieldById(postsTable!, 'title')!.name).toBe('Title');
	});

	test('throws on non-object input', () => {
		expect(() => parseSchema('"string"')).toThrow('Schema must be an object');
		expect(() => parseSchema('null')).toThrow('Schema must be an object');
		expect(() => parseSchema('123')).toThrow('Schema must be an object');
	});

	test('throws on missing name', () => {
		expect(() => parseSchema(JSON.stringify({ tables: {} }))).toThrow(
			'Schema must have a "name" string property',
		);
	});

	test('throws on missing tables', () => {
		expect(() => parseSchema(JSON.stringify({ name: 'Test' }))).toThrow(
			'Schema must have a "tables" object property',
		);
	});

	test('throws on invalid table', () => {
		const json = JSON.stringify({
			name: 'Test',
			tables: { posts: 'not an object' },
		});
		expect(() => parseSchema(json)).toThrow('Table "posts" must be an object');
	});

	test('throws on table missing name', () => {
		const json = JSON.stringify({
			name: 'Test',
			tables: { posts: { fields: {} } },
		});
		expect(() => parseSchema(json)).toThrow(
			'Table "posts" must have a "name" string property',
		);
	});

	test('throws on table missing fields', () => {
		const json = JSON.stringify({
			name: 'Test',
			tables: { posts: { name: 'Posts' } },
		});
		expect(() => parseSchema(json)).toThrow(
			'Table "posts" must have a "fields" object property',
		);
	});

	test('throws on invalid field', () => {
		const json = JSON.stringify({
			name: 'Test',
			tables: { posts: { name: 'Posts', fields: { title: 'not an object' } } },
		});
		expect(() => parseSchema(json)).toThrow(
			'Field "posts.title" must be an object',
		);
	});

	test('throws on field missing name', () => {
		const json = JSON.stringify({
			name: 'Test',
			tables: {
				posts: {
					name: 'Posts',
					description: '',
					icon: null,
					fields: { title: { type: 'text' } },
				},
			},
		});
		expect(() => parseSchema(json)).toThrow(
			'Field "posts.title" must have a "name" string property',
		);
	});

	test('throws on field missing type', () => {
		const json = JSON.stringify({
			name: 'Test',
			tables: {
				posts: {
					name: 'Posts',
					description: '',
					icon: null,
					fields: { title: { name: 'Title' } },
				},
			},
		});
		expect(() => parseSchema(json)).toThrow(
			'Field "posts.title" must have a "type" string property',
		);
	});
});

describe('stringifySchema', () => {
	test('serializes schema to JSON', () => {
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id(), text({ id: 'title', name: 'Title' })],
		});
		const definition: WorkspaceDefinition = {
			name: 'Test',
			description: '',
			icon: null,
			kv: [],
			tables: [postsTable],
		};

		const json = stringifySchema(definition);
		const parsed = JSON.parse(json);
		expect(parsed.name).toBe('Test');
		expect(parsed.tables[0].name).toBe('Posts');
		expect(Array.isArray(parsed.tables[0].fields)).toBe(true);
	});

	test('formats with indentation by default', () => {
		const schema = createEmptySchema('Test');
		const json = stringifySchema(schema);
		expect(json).toContain('\n');
	});

	test('can output compact JSON', () => {
		const schema = createEmptySchema('Test');
		const json = stringifySchema(schema, false);
		expect(json).not.toContain('\n');
	});
});

describe('createEmptySchema', () => {
	test('creates schema with name', () => {
		const schema = createEmptySchema('My Workspace');
		expect(schema.name).toBe('My Workspace');
		expect(schema.icon).toBeNull();
		expect(schema.tables).toEqual([]);
		expect(schema.kv).toEqual([]);
	});

	test('creates schema with icon', () => {
		const schema = createEmptySchema('My Workspace', '📝');
		expect(schema.icon).toBe('emoji:📝');
	});
});

describe('addTable', () => {
	test('adds table to schema', () => {
		const definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});

		const updated = addTable(definition, 'posts', postsTable);
		const postsFromUpdated = updated.tables.find((t) => t.id === 'posts');
		expect(postsFromUpdated).toBeDefined();
		expect(postsFromUpdated!.name).toBe('Posts');
	});

	test('preserves existing tables', () => {
		let definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});
		const usersTable = cellTable('users', {
			name: 'Users',
			fields: [id()],
		});
		definition = addTable(definition, 'posts', postsTable);
		definition = addTable(definition, 'users', usersTable);

		expect(definition.tables).toHaveLength(2);
		expect(definition.tables.find((t) => t.id === 'posts')).toBeDefined();
		expect(definition.tables.find((t) => t.id === 'users')).toBeDefined();
	});

	test('is immutable', () => {
		const definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});
		const updated = addTable(definition, 'posts', postsTable);

		expect(definition.tables.find((t) => t.id === 'posts')).toBeUndefined();
		expect(updated.tables.find((t) => t.id === 'posts')).toBeDefined();
	});
});

describe('removeTable', () => {
	test('removes table from schema', () => {
		let definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});
		const usersTable = cellTable('users', {
			name: 'Users',
			fields: [id()],
		});
		definition = addTable(definition, 'posts', postsTable);
		definition = addTable(definition, 'users', usersTable);

		const updated = removeTable(definition, 'posts');
		expect(updated.tables.find((t) => t.id === 'posts')).toBeUndefined();
		expect(updated.tables.find((t) => t.id === 'users')).toBeDefined();
	});

	test('is immutable', () => {
		let definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});
		definition = addTable(definition, 'posts', postsTable);

		const updated = removeTable(definition, 'posts');
		expect(definition.tables.find((t) => t.id === 'posts')).toBeDefined();
		expect(updated.tables.find((t) => t.id === 'posts')).toBeUndefined();
	});
});

describe('addField', () => {
	test('adds field to table', () => {
		let definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});
		definition = addTable(definition, 'posts', postsTable);

		const updated = addField(
			definition,
			'posts',
			'title',
			text({ id: 'title', name: 'Title' }),
		);

		const postsFromUpdated = updated.tables.find((t) => t.id === 'posts')!;
		expect(getFieldById(postsFromUpdated, 'title')).toBeDefined();
		expect(getFieldById(postsFromUpdated, 'title')!.name).toBe('Title');
	});

	test('throws if table not found', () => {
		const definition = createEmptySchema('Test');
		expect(() =>
			addField(
				definition,
				'posts',
				'title',
				text({ id: 'title', name: 'Title' }),
			),
		).toThrow('Table "posts" not found in schema');
	});

	test('is immutable', () => {
		let definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});
		definition = addTable(definition, 'posts', postsTable);

		const updated = addField(
			definition,
			'posts',
			'title',
			text({ id: 'title', name: 'Title' }),
		);

		const postsFromSchema = definition.tables.find((t) => t.id === 'posts')!;
		const postsFromUpdated = updated.tables.find((t) => t.id === 'posts')!;
		expect(getFieldById(postsFromSchema, 'title')).toBeUndefined();
		expect(getFieldById(postsFromUpdated, 'title')).toBeDefined();
	});
});

describe('removeField', () => {
	test('removes field from table', () => {
		let definition = createEmptySchema('Test');
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});
		definition = addTable(definition, 'posts', postsTable);
		definition = addField(
			definition,
			'posts',
			'title',
			text({ id: 'title', name: 'Title' }),
		);
		definition = addField(
			definition,
			'posts',
			'views',
			integer({ id: 'views', name: 'Views' }),
		);

		const updated = removeField(definition, 'posts', 'title');
		const postsFromUpdated = updated.tables.find((t) => t.id === 'posts')!;
		expect(getFieldById(postsFromUpdated, 'title')).toBeUndefined();
		expect(getFieldById(postsFromUpdated, 'views')).toBeDefined();
	});

	test('throws if table not found', () => {
		const definition = createEmptySchema('Test');
		expect(() => removeField(definition, 'posts', 'title')).toThrow(
			'Table "posts" not found in schema',
		);
	});
});

describe('getFieldById', () => {
	test('returns field by id', () => {
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id(), text({ id: 'title', name: 'Title' })],
		});

		expect(getFieldById(postsTable, 'title')).toBeDefined();
		expect(getFieldById(postsTable, 'title')!.name).toBe('Title');
	});

	test('returns undefined for non-existent field', () => {
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [id()],
		});

		expect(getFieldById(postsTable, 'nonexistent')).toBeUndefined();
	});
});

describe('getFieldIds', () => {
	test('returns all field ids in order', () => {
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [
				id(),
				text({ id: 'title', name: 'Title' }),
				integer({ id: 'views', name: 'Views' }),
			],
		});

		const ids = getFieldIds(postsTable);
		expect(ids).toEqual(['id', 'title', 'views']);
	});

	test('returns empty array for table with no fields', () => {
		const postsTable = cellTable('posts', {
			name: 'Posts',
			fields: [],
		});

		expect(getFieldIds(postsTable)).toEqual([]);
	});
});
