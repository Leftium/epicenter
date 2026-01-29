import { describe, expect, test } from 'bun:test';
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
import { id, text, integer } from '../core/schema/fields/factories';
import type { SchemaTableDefinition, WorkspaceDefinition } from './types';

/**
 * Helper to create a table with array-based fields for cell workspace tests.
 * Simulates what would come from parsed JSON.
 */
function cellTable(options: {
	name: string;
	fields: SchemaTableDefinition['fields'];
	description?: string;
}): SchemaTableDefinition {
	return {
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
						title: text('title', { name: 'Title' }),
						views: integer('views', { name: 'Views' }),
					},
				},
			},
		});

		const schema = parseSchema(json);
		expect(schema.name).toBe('Test Workspace');
		expect(schema.icon).toBe('emoji:📝');
		expect(schema.tables.posts).toBeDefined();
		expect(schema.tables.posts!.name).toBe('Blog Posts');
		// Fields are now an array
		expect(Array.isArray(schema.tables.posts!.fields)).toBe(true);
		expect(getFieldById(schema.tables.posts!, 'title')).toBeDefined();
		expect(getFieldIds(schema.tables.posts!)).toContain('title');
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
						text('title', { name: 'Title' }),
						integer('views', { name: 'Views' }),
					],
				},
			},
		});

		const schema = parseSchema(json);
		expect(schema.name).toBe('Test Workspace');
		expect(schema.tables.posts).toBeDefined();
		expect(Array.isArray(schema.tables.posts!.fields)).toBe(true);
		expect(getFieldById(schema.tables.posts!, 'title')).toBeDefined();
		expect(getFieldById(schema.tables.posts!, 'title')!.name).toBe('Title');
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
		const postsTable = cellTable({
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
			],
		});
		const schema: WorkspaceDefinition = {
			name: 'Test',
			description: '',
			icon: null,
			kv: {},
			tables: {
				posts: postsTable,
			},
		};

		const json = stringifySchema(schema);
		const parsed = JSON.parse(json);
		expect(parsed.name).toBe('Test');
		expect(parsed.tables.posts.name).toBe('Posts');
		expect(Array.isArray(parsed.tables.posts.fields)).toBe(true);
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
		expect(schema.tables).toEqual({});
		expect(schema.kv).toEqual({});
	});

	test('creates schema with icon', () => {
		const schema = createEmptySchema('My Workspace', '📝');
		expect(schema.icon).toBe('emoji:📝');
	});
});

describe('addTable', () => {
	test('adds table to schema', () => {
		const schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});

		const updated = addTable(schema, 'posts', postsTable);
		expect(updated.tables.posts).toBeDefined();
		expect(updated.tables.posts!.name).toBe('Posts');
	});

	test('preserves existing tables', () => {
		let schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});
		const usersTable = cellTable({
			name: 'Users',
			fields: [id()],
		});
		schema = addTable(schema, 'posts', postsTable);
		schema = addTable(schema, 'users', usersTable);

		expect(Object.keys(schema.tables)).toHaveLength(2);
		expect(schema.tables.posts).toBeDefined();
		expect(schema.tables.users).toBeDefined();
	});

	test('is immutable', () => {
		const schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});
		const updated = addTable(schema, 'posts', postsTable);

		expect(schema.tables.posts).toBeUndefined();
		expect(updated.tables.posts).toBeDefined();
	});
});

describe('removeTable', () => {
	test('removes table from schema', () => {
		let schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});
		const usersTable = cellTable({
			name: 'Users',
			fields: [id()],
		});
		schema = addTable(schema, 'posts', postsTable);
		schema = addTable(schema, 'users', usersTable);

		const updated = removeTable(schema, 'posts');
		expect(updated.tables.posts).toBeUndefined();
		expect(updated.tables.users).toBeDefined();
	});

	test('is immutable', () => {
		let schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});
		schema = addTable(schema, 'posts', postsTable);

		const updated = removeTable(schema, 'posts');
		expect(schema.tables.posts).toBeDefined();
		expect(updated.tables.posts).toBeUndefined();
	});
});

describe('addField', () => {
	test('adds field to table', () => {
		let schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});
		schema = addTable(schema, 'posts', postsTable);

		const updated = addField(schema, 'posts', 'title', text('title', { name: 'Title' }));

		expect(getFieldById(updated.tables.posts!, 'title')).toBeDefined();
		expect(getFieldById(updated.tables.posts!, 'title')!.name).toBe('Title');
	});

	test('throws if table not found', () => {
		const schema = createEmptySchema('Test');
		expect(() =>
			addField(schema, 'posts', 'title', text('title', { name: 'Title' })),
		).toThrow('Table "posts" not found in schema');
	});

	test('is immutable', () => {
		let schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});
		schema = addTable(schema, 'posts', postsTable);

		const updated = addField(schema, 'posts', 'title', text('title', { name: 'Title' }));

		expect(getFieldById(schema.tables.posts!, 'title')).toBeUndefined();
		expect(getFieldById(updated.tables.posts!, 'title')).toBeDefined();
	});
});

describe('removeField', () => {
	test('removes field from table', () => {
		let schema = createEmptySchema('Test');
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});
		schema = addTable(schema, 'posts', postsTable);
		schema = addField(schema, 'posts', 'title', text('title', { name: 'Title' }));
		schema = addField(schema, 'posts', 'views', integer('views', { name: 'Views' }));

		const updated = removeField(schema, 'posts', 'title');
		expect(getFieldById(updated.tables.posts!, 'title')).toBeUndefined();
		expect(getFieldById(updated.tables.posts!, 'views')).toBeDefined();
	});

	test('throws if table not found', () => {
		const schema = createEmptySchema('Test');
		expect(() => removeField(schema, 'posts', 'title')).toThrow(
			'Table "posts" not found in schema',
		);
	});
});

describe('getFieldById', () => {
	test('returns field by id', () => {
		const postsTable = cellTable({
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
			],
		});

		expect(getFieldById(postsTable, 'title')).toBeDefined();
		expect(getFieldById(postsTable, 'title')!.name).toBe('Title');
	});

	test('returns undefined for non-existent field', () => {
		const postsTable = cellTable({
			name: 'Posts',
			fields: [id()],
		});

		expect(getFieldById(postsTable, 'nonexistent')).toBeUndefined();
	});
});

describe('getFieldIds', () => {
	test('returns all field ids in order', () => {
		const postsTable = cellTable({
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
				integer('views', { name: 'Views' }),
			],
		});

		const ids = getFieldIds(postsTable);
		expect(ids).toEqual(['id', 'title', 'views']);
	});

	test('returns empty array for table with no fields', () => {
		const postsTable = cellTable({
			name: 'Posts',
			fields: [],
		});

		expect(getFieldIds(postsTable)).toEqual([]);
	});
});

