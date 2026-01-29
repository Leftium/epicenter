import { describe, expect, test } from 'bun:test';
import {
	addField,
	addTable,
	createEmptySchema,
	parseSchema,
	removeField,
	removeTable,
	stringifySchema,
} from './schema-file';
import { id, table, text, integer } from '../core/schema/fields/factories';
import type { WorkspaceDefinition } from './types';

describe('parseSchema', () => {
	test('parses valid schema', () => {
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
						title: text({ name: 'Title' }),
						views: integer({ name: 'Views' }),
					},
				},
			},
		});

		const schema = parseSchema(json);
		expect(schema.name).toBe('Test Workspace');
		expect(schema.icon).toBe('emoji:📝');
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
		const postsTable = table({
			name: 'Posts',
			fields: {
				id: id(),
				title: text({ name: 'Title' }),
			},
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
		const postsTable = table({ name: 'Posts', fields: { id: id() } });

		const updated = addTable(schema, 'posts', postsTable);
		expect(updated.tables.posts).toBeDefined();
		expect(updated.tables.posts!.name).toBe('Posts');
	});

	test('preserves existing tables', () => {
		let schema = createEmptySchema('Test');
		const postsTable = table({ name: 'Posts', fields: { id: id() } });
		const usersTable = table({ name: 'Users', fields: { id: id() } });
		schema = addTable(schema, 'posts', postsTable);
		schema = addTable(schema, 'users', usersTable);

		expect(Object.keys(schema.tables)).toHaveLength(2);
		expect(schema.tables.posts).toBeDefined();
		expect(schema.tables.users).toBeDefined();
	});

	test('is immutable', () => {
		const schema = createEmptySchema('Test');
		const postsTable = table({ name: 'Posts', fields: { id: id() } });
		const updated = addTable(schema, 'posts', postsTable);

		expect(schema.tables.posts).toBeUndefined();
		expect(updated.tables.posts).toBeDefined();
	});
});

describe('removeTable', () => {
	test('removes table from schema', () => {
		let schema = createEmptySchema('Test');
		const postsTable = table({ name: 'Posts', fields: { id: id() } });
		const usersTable = table({ name: 'Users', fields: { id: id() } });
		schema = addTable(schema, 'posts', postsTable);
		schema = addTable(schema, 'users', usersTable);

		const updated = removeTable(schema, 'posts');
		expect(updated.tables.posts).toBeUndefined();
		expect(updated.tables.users).toBeDefined();
	});

	test('is immutable', () => {
		let schema = createEmptySchema('Test');
		const postsTable = table({ name: 'Posts', fields: { id: id() } });
		schema = addTable(schema, 'posts', postsTable);

		const updated = removeTable(schema, 'posts');
		expect(schema.tables.posts).toBeDefined();
		expect(updated.tables.posts).toBeUndefined();
	});
});

describe('addField', () => {
	test('adds field to table', () => {
		let schema = createEmptySchema('Test');
		const postsTable = table({ name: 'Posts', fields: { id: id() } });
		schema = addTable(schema, 'posts', postsTable);

		const updated = addField(schema, 'posts', 'title', text({ name: 'Title' }));

		expect(updated.tables.posts!.fields.title).toBeDefined();
		expect(updated.tables.posts!.fields.title!.name).toBe('Title');
	});

	test('throws if table not found', () => {
		const schema = createEmptySchema('Test');
		expect(() =>
			addField(schema, 'posts', 'title', text({ name: 'Title' })),
		).toThrow('Table "posts" not found in schema');
	});

	test('is immutable', () => {
		let schema = createEmptySchema('Test');
		const postsTable = table({ name: 'Posts', fields: { id: id() } });
		schema = addTable(schema, 'posts', postsTable);

		const updated = addField(schema, 'posts', 'title', text({ name: 'Title' }));

		expect(schema.tables.posts!.fields.title).toBeUndefined();
		expect(updated.tables.posts!.fields.title).toBeDefined();
	});
});

describe('removeField', () => {
	test('removes field from table', () => {
		let schema = createEmptySchema('Test');
		const postsTable = table({ name: 'Posts', fields: { id: id() } });
		schema = addTable(schema, 'posts', postsTable);
		schema = addField(schema, 'posts', 'title', text({ name: 'Title' }));
		schema = addField(schema, 'posts', 'views', integer({ name: 'Views' }));

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

