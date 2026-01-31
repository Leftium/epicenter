import { describe, expect, test } from 'bun:test';
import { id, integer, text } from '../core/schema/fields/factories';
import { parseSchema } from './schema-file';

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
		expect(postsTable!.fields.find((f) => f.id === 'title')).toBeDefined();
		expect(postsTable!.fields.map((f) => f.id)).toContain('title');
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
		expect(postsTable!.fields.find((f) => f.id === 'title')).toBeDefined();
		expect(postsTable!.fields.find((f) => f.id === 'title')!.name).toBe(
			'Title',
		);
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
