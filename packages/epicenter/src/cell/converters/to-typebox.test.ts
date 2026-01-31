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
	test('maps field types to correct TypeBox schemas', () => {
		// text → String
		expect(Value.Check(schemaFieldToTypebox(text({ id: 't', name: 'T' })), 'hello')).toBe(true);

		// richtext → String
		expect(Value.Check(schemaFieldToTypebox(richtext({ id: 'r', name: 'R' })), 'content')).toBe(true);

		// integer → Integer (rejects floats)
		const intSchema = schemaFieldToTypebox(integer({ id: 'i', name: 'I' }));
		expect(Value.Check(intSchema, 42)).toBe(true);
		expect(Value.Check(intSchema, 42.5)).toBe(false);

		// real → Number (accepts floats)
		expect(Value.Check(schemaFieldToTypebox(real({ id: 'r', name: 'R' })), 3.14)).toBe(true);

		// boolean → Boolean (rejects truthy/falsy)
		const boolSchema = schemaFieldToTypebox(boolean({ id: 'b', name: 'B' }));
		expect(Value.Check(boolSchema, true)).toBe(true);
		expect(Value.Check(boolSchema, 1)).toBe(false);

		// date → String (accepts any string)
		expect(Value.Check(schemaFieldToTypebox(date({ id: 'd', name: 'D' })), '2024-01-01')).toBe(true);

		// json → Unknown (accepts anything)
		const jsonSchema = schemaFieldToTypebox(json({ id: 'j', name: 'J', schema: Type.Unknown() }));
		expect(Value.Check(jsonSchema, { any: 'value' })).toBe(true);
		expect(Value.Check(jsonSchema, null)).toBe(true);
	});

	test('strict schemas reject null', () => {
		// One test to prove we're not wrapping with nullable
		expect(Value.Check(schemaFieldToTypebox(text({ id: 't', name: 'T' })), null)).toBe(false);
		expect(Value.Check(schemaFieldToTypebox(integer({ id: 'i', name: 'I' })), null)).toBe(false);
	});

	describe('select', () => {
		test('accepts only defined options', () => {
			const field = select({
				id: 'status',
				name: 'Status',
				options: ['draft', 'published'] as const,
			});
			const schema = schemaFieldToTypebox(field);

			expect(Value.Check(schema, 'draft')).toBe(true);
			expect(Value.Check(schema, 'published')).toBe(true);
			expect(Value.Check(schema, 'pending')).toBe(false);
			expect(Value.Check(schema, 'DRAFT')).toBe(false);
		});
	});

	describe('tags', () => {
		test('accepts array of defined options', () => {
			const field = tags({
				id: 'tags',
				name: 'Tags',
				options: ['tech', 'personal', 'work'] as const,
			});
			const schema = schemaFieldToTypebox(field);

			expect(Value.Check(schema, ['tech'])).toBe(true);
			expect(Value.Check(schema, ['tech', 'work'])).toBe(true);
			expect(Value.Check(schema, [])).toBe(true);
			expect(Value.Check(schema, ['invalid'])).toBe(false);
		});

		test('falls back to string array without options', () => {
			const field = tags({ id: 'tags', name: 'Tags' });
			const schema = schemaFieldToTypebox(field);
			expect(Value.Check(schema, ['anything', 'goes'])).toBe(true);
		});
	});
});

describe('schemaTableToTypebox', () => {
	test('creates object schema with optional fields', () => {
		const tableSchema = table({
			id: 'posts',
			name: 'Posts',
			fields: [
				id(),
				text({ id: 'title', name: 'Title' }),
				integer({ id: 'views', name: 'Views' }),
			] as const,
		});
		const schema = schemaTableToTypebox(tableSchema);

		// Valid row
		expect(Value.Check(schema, { title: 'Hello', views: 100 })).toBe(true);

		// Missing fields OK (optional)
		expect(Value.Check(schema, { title: 'Hello' })).toBe(true);
		expect(Value.Check(schema, {})).toBe(true);

		// Additional properties OK (advisory)
		expect(Value.Check(schema, { title: 'Hello', extra: 'field' })).toBe(true);

		// Wrong types rejected (strict)
		expect(Value.Check(schema, { title: 123 })).toBe(false);
		expect(Value.Check(schema, { views: 'not a number' })).toBe(false);
		expect(Value.Check(schema, { title: null })).toBe(false);
	});

	test('compiles to JIT validator with error reporting', () => {
		const tableSchema = table({
			id: 'posts',
			name: 'Posts',
			fields: [
				id(),
				text({ id: 'title', name: 'Title' }),
				select({ id: 'status', name: 'Status', options: ['draft', 'published'] as const }),
			] as const,
		});
		const validator = Compile(schemaTableToTypebox(tableSchema));

		expect(validator.Check({ title: 'Hello', status: 'draft' })).toBe(true);
		expect(validator.Check({ title: 'Hello', status: 'invalid' })).toBe(false);

		const errors = [...validator.Errors({ title: 123 })];
		expect(errors.length).toBeGreaterThan(0);
	});
});
