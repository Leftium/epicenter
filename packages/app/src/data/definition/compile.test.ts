/**
 * Declaration compilation preserves codecs and compiles trusted field schemas.
 * Key behaviors: malformed codecs and compiler failures report errors; a
 * native schema without a hint is a field with the JSON editor; conformance
 * requires stored fields to be present.
 */
import { expect, test } from 'bun:test';
import { defineStore } from '@epicenter/app';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { plainText } from './body.js';
import { compileData } from './compile.js';
import { field } from './declaration.js';
import { defineTable } from './define.js';

const database = defineStore({
	id: 'so.epicenter.data',
	kv: { name: field.string() },
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
			},
			body: plainText(),
		}),
	},
});

test('trusted TypeScript definitions compile and retain their codecs', () => {
	const result = expectOk(compileData(database));
	expect(result.tables.get('notes')?.body).toBeDefined();
	expect([...(result.tables.get('notes')?.fields.keys() ?? [])]).toEqual([
		'title',
	]);
});

test('compilation is memoized by definition identity', () => {
	expect(compileData(database)).toBe(compileData(database));
});

test('omitting a codec compiles only the declared fields', () => {
	const definition = defineStore({
		id: 'so.epicenter.fields-only',
		kv: {},
		tables: {
			queries: defineTable({
				fields: { name: field.string(), sql: field.string() },
			}),
		},
	});
	const table = expectOk(compileData(definition)).tables.get('queries');
	expect(table?.body).toBeUndefined();
	expect([...table!.fields.keys()]).toEqual(['name', 'sql']);
});

test('an explicitly malformed codec is refused at compilation', () => {
	for (const body of [
		null,
		{},
		{ encode: 'invalid', decode() {} },
		{ encode() {} },
	]) {
		const error = expectErr(
			compileData({
				id: 'so.epicenter.invalid-codec',
				kv: {},
				tables: {
					notes: {
						fields: {},
						// @ts-expect-error exercise the runtime declaration boundary
						body,
					},
				},
			}),
		);
		expect(error.name).toBe('Malformed');
		expect(error.message).toContain('invalid body codec');
	}
});

test('a native schema no helper built is a field with the JSON editor', () => {
	for (const bare of [Type.String(), { type: 'string' }]) {
		const value = expectOk(
			compileData({ id: 'test.native', tables: {}, kv: { value: bare } }),
		).kv.fields.get('value');
		expect(value?.editor).toEqual({ kind: 'json', nullable: false });
		expect(value?.check('text')).toBe(true);
		expect(value?.check(1)).toBe(false);
	}
	const helper = expectOk(
		compileData({
			id: 'test.helper',
			tables: {},
			kv: { value: field.nullable(field.reference('notes')) },
		}),
	).kv.fields.get('value');
	expect(helper?.editor).toEqual({
		kind: 'reference',
		nullable: true,
		target: 'notes',
	});
});

test('field compiler failures identify the table and field', () => {
	const error = expectErr(
		compileData({
			id: 'test.invalid-pattern',
			kv: {},
			tables: {
				notes: defineTable({
					fields: {
						title: field.json({ type: 'string', pattern: '[' }),
					},
				}),
			},
		}),
	);
	expect(error).toMatchObject({
		name: 'UnrecognizedField',
		table: 'notes',
		field: 'title',
	});
	expect(error.message).toContain('regular expression');
});

test('nullable fields accept explicit null but still require stored presence', () => {
	const definition = expectOk(
		compileData({
			id: 'test.nullable',
			kv: { title: field.nullable(field.string()) },
			tables: {},
		}),
	);
	expect(definition.kv.conformance({ title: null })).toEqual({
		conforming: { title: null },
		issues: [],
	});
	expect(definition.kv.conformance({}).issues).toEqual([
		{ field: 'title', message: 'title is missing' },
	]);
});

test('trusted JSON fields retain compiler support for local schema references', () => {
	const definition = expectOk(
		compileData({
			id: 'test.json-reference',
			kv: {
				value: field.json({
					$defs: { text: { type: 'string', minLength: 2 } },
					$ref: '#/$defs/text',
				}),
			},
			tables: {},
		}),
	);
	expect(definition.kv.conformance({ value: 'yes' }).issues).toEqual([]);
	expect(definition.kv.conformance({ value: 'x' }).issues).toHaveLength(1);
});
