import { describe, expect, test } from 'bun:test';
import {
	addField,
	addTable,
	createEmptySchema,
	getNextFieldOrder,
	getSortedFields,
	parseSchema,
	removeField,
	removeTable,
	stringifySchema,
} from './schema-file';
import type { SchemaTableDefinition, WorkspaceSchema } from './types';

describe('parseSchema', () => {
	test('parses valid schema', () => {
		const json = JSON.stringify({
			name: 'Test Workspace',
			icon: '📝',
			tables: {
				posts: {
					name: 'Blog Posts',
					fields: {
						title: { name: 'Title', type: 'text', order: 1 },
						views: { name: 'Views', type: 'integer', order: 2 },
					},
				},
			},
		});

		const schema = parseSchema(json);
		expect(schema.name).toBe('Test Workspace');
		expect(schema.icon).toBe('📝');
		expect(schema.tables.posts).toBeDefined();
		expect(schema.tables.posts!.name).toBe('Blog Posts');
		expect(schema.tables.posts!.fields.title).toBeDefined();
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
				posts: { name: 'Posts', fields: { title: { type: 'text', order: 1 } } },
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
					fields: { title: { name: 'Title', order: 1 } },
				},
			},
		});
		expect(() => parseSchema(json)).toThrow(
			'Field "posts.title" must have a "type" string property',
		);
	});

	test('throws on field missing order', () => {
		const json = JSON.stringify({
			name: 'Test',
			tables: {
				posts: {
					name: 'Posts',
					fields: { title: { name: 'Title', type: 'text' } },
				},
			},
		});
		expect(() => parseSchema(json)).toThrow(
			'Field "posts.title" must have an "order" number property',
		);
	});
});

describe('stringifySchema', () => {
	test('serializes schema to JSON', () => {
		const schema: WorkspaceSchema = {
			name: 'Test',
			tables: {
				posts: {
					name: 'Posts',
					fields: {
						title: { name: 'Title', type: 'text', order: 1 },
					},
				},
			},
		};

		const json = stringifySchema(schema);
		const parsed = JSON.parse(json);
		expect(parsed.name).toBe('Test');
		expect(parsed.tables.posts.name).toBe('Posts');
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
		expect(schema.icon).toBe('📝');
	});
});

describe('addTable', () => {
	test('adds table to schema', () => {
		const schema = createEmptySchema('Test');
		const table: SchemaTableDefinition = {
			name: 'Posts',
			fields: {},
		};

		const updated = addTable(schema, 'posts', table);
		expect(updated.tables.posts).toBeDefined();
		expect(updated.tables.posts!.name).toBe('Posts');
	});

	test('preserves existing tables', () => {
		let schema = createEmptySchema('Test');
		schema = addTable(schema, 'posts', { name: 'Posts', fields: {} });
		schema = addTable(schema, 'users', { name: 'Users', fields: {} });

		expect(Object.keys(schema.tables)).toHaveLength(2);
		expect(schema.tables.posts).toBeDefined();
		expect(schema.tables.users).toBeDefined();
	});

	test('is immutable', () => {
		const schema = createEmptySchema('Test');
		const updated = addTable(schema, 'posts', { name: 'Posts', fields: {} });

		expect(schema.tables.posts).toBeUndefined();
		expect(updated.tables.posts).toBeDefined();
	});
});

describe('removeTable', () => {
	test('removes table from schema', () => {
		let schema = createEmptySchema('Test');
		schema = addTable(schema, 'posts', { name: 'Posts', fields: {} });
		schema = addTable(schema, 'users', { name: 'Users', fields: {} });

		const updated = removeTable(schema, 'posts');
		expect(updated.tables.posts).toBeUndefined();
		expect(updated.tables.users).toBeDefined();
	});

	test('is immutable', () => {
		let schema = createEmptySchema('Test');
		schema = addTable(schema, 'posts', { name: 'Posts', fields: {} });

		const updated = removeTable(schema, 'posts');
		expect(schema.tables.posts).toBeDefined();
		expect(updated.tables.posts).toBeUndefined();
	});
});

describe('addField', () => {
	test('adds field to table', () => {
		let schema = createEmptySchema('Test');
		schema = addTable(schema, 'posts', { name: 'Posts', fields: {} });

		const updated = addField(schema, 'posts', 'title', {
			name: 'Title',
			type: 'text',
			order: 1,
		});

		expect(updated.tables.posts!.fields.title).toBeDefined();
		expect(updated.tables.posts!.fields.title!.name).toBe('Title');
	});

	test('throws if table not found', () => {
		const schema = createEmptySchema('Test');
		expect(() =>
			addField(schema, 'posts', 'title', {
				name: 'Title',
				type: 'text',
				order: 1,
			}),
		).toThrow('Table "posts" not found in schema');
	});

	test('is immutable', () => {
		let schema = createEmptySchema('Test');
		schema = addTable(schema, 'posts', { name: 'Posts', fields: {} });

		const updated = addField(schema, 'posts', 'title', {
			name: 'Title',
			type: 'text',
			order: 1,
		});

		expect(schema.tables.posts!.fields.title).toBeUndefined();
		expect(updated.tables.posts!.fields.title).toBeDefined();
	});
});

describe('removeField', () => {
	test('removes field from table', () => {
		let schema = createEmptySchema('Test');
		schema = addTable(schema, 'posts', { name: 'Posts', fields: {} });
		schema = addField(schema, 'posts', 'title', {
			name: 'Title',
			type: 'text',
			order: 1,
		});
		schema = addField(schema, 'posts', 'views', {
			name: 'Views',
			type: 'integer',
			order: 2,
		});

		const updated = removeField(schema, 'posts', 'title');
		expect(updated.tables.posts!.fields.title).toBeUndefined();
		expect(updated.tables.posts!.fields.views).toBeDefined();
	});

	test('throws if table not found', () => {
		const schema = createEmptySchema('Test');
		expect(() => removeField(schema, 'posts', 'title')).toThrow(
			'Table "posts" not found in schema',
		);
	});
});

describe('getSortedFields', () => {
	test('returns fields sorted by order', () => {
		const table: SchemaTableDefinition = {
			name: 'Posts',
			fields: {
				views: { name: 'Views', type: 'integer', order: 3 },
				title: { name: 'Title', type: 'text', order: 1 },
				published: { name: 'Published', type: 'boolean', order: 2 },
			},
		};

		const sorted = getSortedFields(table);
		expect(sorted.map(([id]) => id)).toEqual(['title', 'published', 'views']);
	});

	test('returns empty array for table with no fields', () => {
		const table: SchemaTableDefinition = {
			name: 'Empty',
			fields: {},
		};

		expect(getSortedFields(table)).toEqual([]);
	});
});

describe('getNextFieldOrder', () => {
	test('returns 1 for table with no fields', () => {
		const table: SchemaTableDefinition = {
			name: 'Empty',
			fields: {},
		};

		expect(getNextFieldOrder(table)).toBe(1);
	});

	test('returns max + 1 for table with fields', () => {
		const table: SchemaTableDefinition = {
			name: 'Posts',
			fields: {
				title: { name: 'Title', type: 'text', order: 1 },
				views: { name: 'Views', type: 'integer', order: 5 },
				published: { name: 'Published', type: 'boolean', order: 3 },
			},
		};

		expect(getNextFieldOrder(table)).toBe(6);
	});
});
