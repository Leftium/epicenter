import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import {
	boolean,
	date,
	id,
	integer,
	json,
	real,
	richtext,
	select,
	table,
	tags,
	text,
} from '../../core/schema/fields/factories';
import { schemaFieldToTypebox, schemaTableToTypebox } from './to-typebox';

describe('schemaFieldToTypebox', () => {
	describe('text', () => {
		test('accepts strings', () => {
			const field = text('title', { name: 'Title' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 'hello')).toBe(true);
			expect(Value.Check(schema, '')).toBe(true);
		});

		test('accepts null (all fields nullable)', () => {
			const field = text('title', { name: 'Title' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});

		test('rejects non-strings', () => {
			const field = text('title', { name: 'Title' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 123)).toBe(false);
			expect(Value.Check(schema, {})).toBe(false);
		});
	});

	describe('richtext', () => {
		test('accepts strings and null', () => {
			const field = richtext('content', { name: 'Content' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 'content')).toBe(true);
			expect(Value.Check(schema, null)).toBe(true);
		});
	});

	describe('integer', () => {
		test('accepts whole numbers', () => {
			const field = integer('count', { name: 'Count' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 0)).toBe(true);
			expect(Value.Check(schema, 42)).toBe(true);
			expect(Value.Check(schema, -100)).toBe(true);
		});

		test('accepts null', () => {
			const field = integer('count', { name: 'Count' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});

		test('rejects floats', () => {
			const field = integer('count', { name: 'Count' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 42.5)).toBe(false);
		});

		test('rejects non-numbers', () => {
			const field = integer('count', { name: 'Count' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, '42')).toBe(false);
		});
	});

	describe('real', () => {
		test('accepts any number', () => {
			const field = real('price', { name: 'Price' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 0)).toBe(true);
			expect(Value.Check(schema, 3.14)).toBe(true);
			expect(Value.Check(schema, -99.99)).toBe(true);
		});

		test('accepts null', () => {
			const field = real('price', { name: 'Price' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});
	});

	describe('boolean', () => {
		test('accepts true and false', () => {
			const field = boolean('active', { name: 'Active' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, true)).toBe(true);
			expect(Value.Check(schema, false)).toBe(true);
		});

		test('accepts null', () => {
			const field = boolean('active', { name: 'Active' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});

		test('rejects truthy/falsy values', () => {
			const field = boolean('active', { name: 'Active' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 0)).toBe(false);
			expect(Value.Check(schema, 1)).toBe(false);
			expect(Value.Check(schema, 'true')).toBe(false);
		});
	});

	describe('date', () => {
		test('accepts any string (no strict validation)', () => {
			const field = date('created', { name: 'Created' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, '2024-01-01')).toBe(true);
			expect(Value.Check(schema, '2024-01-01T12:00:00Z')).toBe(true);
			expect(Value.Check(schema, 'not-a-date')).toBe(true); // Advisory, not strict
		});

		test('accepts null', () => {
			const field = date('created', { name: 'Created' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});

		test('rejects non-strings', () => {
			const field = date('created', { name: 'Created' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 1704067200000)).toBe(false);
		});
	});

	describe('datetime', () => {
		test('produces string schema (same as date)', () => {
			// Note: datetime uses date factory since they're equivalent at runtime
			const field = date('updated', { name: 'Updated' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, '2024-01-01T12:00:00Z')).toBe(true);
			expect(Value.Check(schema, null)).toBe(true);
		});
	});

	describe('select', () => {
		test('accepts defined options', () => {
			const field = select('status', {
				name: 'Status',
				options: ['draft', 'published', 'archived'] as const,
			});
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 'draft')).toBe(true);
			expect(Value.Check(schema, 'published')).toBe(true);
			expect(Value.Check(schema, 'archived')).toBe(true);
		});

		test('rejects undefined options', () => {
			const field = select('status', {
				name: 'Status',
				options: ['draft', 'published'] as const,
			});
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, 'pending')).toBe(false);
			expect(Value.Check(schema, 'DRAFT')).toBe(false);
		});

		test('accepts null', () => {
			const field = select('status', {
				name: 'Status',
				options: ['draft', 'published'] as const,
			});
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});

	});

	describe('tags', () => {
		test('accepts array of defined options', () => {
			const field = tags('tags', {
				name: 'Tags',
				options: ['tech', 'personal', 'work'] as const,
			});
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, ['tech'])).toBe(true);
			expect(Value.Check(schema, ['tech', 'work'])).toBe(true);
			expect(Value.Check(schema, [])).toBe(true);
		});

		test('rejects invalid options', () => {
			const field = tags('tags', {
				name: 'Tags',
				options: ['tech', 'personal'] as const,
			});
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, ['invalid'])).toBe(false);
			expect(Value.Check(schema, ['tech', 'invalid'])).toBe(false);
		});

		test('accepts null', () => {
			const field = tags('tags', {
				name: 'Tags',
				options: ['tech'] as const,
			});
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});

		test('falls back to string array if no options', () => {
			const field = tags('tags', { name: 'Tags' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, ['anything', 'goes'])).toBe(true);
		});
	});

	describe('json', () => {
		test('accepts any value (Type.Unknown)', () => {
			const field = json('data', { name: 'Data', schema: Type.Unknown() });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, { key: 'value' })).toBe(true);
			expect(Value.Check(schema, [1, 2, 3])).toBe(true);
			expect(Value.Check(schema, 'string')).toBe(true);
			expect(Value.Check(schema, 123)).toBe(true);
		});

		test('accepts null', () => {
			const field = json('data', { name: 'Data', schema: Type.Unknown() });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, null)).toBe(true);
		});
	});
});

describe('schemaTableToTypebox', () => {
	test('creates object schema from table definition', () => {
		const tableSchema = table('posts', {
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
				integer('views', { name: 'Views' }),
			] as const,
		});
		const schema = schemaTableToTypebox(tableSchema);
		expect(schema.type).toBe('object');
		expect(schema.properties).toBeDefined();
	});

	test('validates rows with correct types', () => {
		const tableSchema = table('posts', {
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
				integer('views', { name: 'Views' }),
			] as const,
		});
		const schema = schemaTableToTypebox(tableSchema);

		expect(Value.Check(schema, { title: 'Hello', views: 100 })).toBe(true);
		expect(Value.Check(schema, { title: 'Hello', views: null })).toBe(true);
	});

	test('allows additional properties (advisory behavior)', () => {
		const tableSchema = table('posts', {
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
			] as const,
		});
		const schema = schemaTableToTypebox(tableSchema);

		expect(Value.Check(schema, { title: 'Hello', extra: 'field' })).toBe(true);
		expect(Value.Check(schema, { title: 'Hello', another: 123 })).toBe(true);
	});

	test('rejects invalid field values', () => {
		const tableSchema = table('posts', {
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
				integer('views', { name: 'Views' }),
			] as const,
		});
		const schema = schemaTableToTypebox(tableSchema);

		expect(Value.Check(schema, { title: 123, views: 100 })).toBe(false);
		expect(Value.Check(schema, { title: 'Hello', views: 'not a number' })).toBe(
			false,
		);
	});

	test('can be compiled to JIT validator', () => {
		const tableSchema = table('posts', {
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
				select('status', {
					name: 'Status',
					options: ['draft', 'published'] as const,
				}),
			] as const,
		});
		const schema = schemaTableToTypebox(tableSchema);
		const validator = Compile(schema);

		expect(validator.Check({ title: 'Hello', status: 'draft' })).toBe(true);
		expect(validator.Check({ title: 'Hello', status: 'invalid' })).toBe(false);
	});

	test('compiled validator reports errors', () => {
		const tableSchema = table('posts', {
			name: 'Posts',
			fields: [
				id(),
				text('title', { name: 'Title' }),
			] as const,
		});
		const schema = schemaTableToTypebox(tableSchema);
		const validator = Compile(schema);
		const errors = [...validator.Errors({ title: 123 })];

		expect(errors.length).toBeGreaterThan(0);
	});
});
