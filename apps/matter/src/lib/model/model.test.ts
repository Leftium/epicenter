import { describe, expect, test } from 'bun:test';
import { parseModel, validateModel } from './model';

describe('validateModel (the matter.json gate)', () => {
	test('accepts the supported subset and derives kinds in declared order', () => {
		const { data, error } = validateModel({
			fields: {
				title: { type: 'string' },
				status: { type: 'string', enum: ['draft', 'published'] },
				labels: { type: 'array', items: { enum: ['red', 'green'] } },
				tags: { type: 'array', items: { type: 'string' } },
				url: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
			},
		});
		expect(error).toBeNull();
		if (error) throw new Error(error.message);
		expect(data.fields.map((f) => [f.name, f.derived.kind, f.derived.nullable])).toEqual([
			['title', 'string', false],
			['status', 'select', false],
			['labels', 'multiSelect', false],
			['tags', 'tags', false],
			['url', 'url', true],
		]);
	});

	test('rejects a non-object top level', () => {
		expect(validateModel(42).error?.name).toBe('NotAnObject');
		expect(validateModel(null).error?.name).toBe('NotAnObject');
		expect(validateModel([]).error?.name).toBe('NotAnObject');
	});

	test('rejects a missing fields object', () => {
		const { error } = validateModel({ views: {} });
		expect(error?.name).toBe('MissingFields');
		expect(error?.message).toMatch(/fields/);
	});

	test('rejects a field that is not a schema object', () => {
		const { error } = validateModel({ fields: { title: 'string' } });
		expect(error?.name).toBe('FieldNotObject');
		expect(error?.message).toMatch(/title/);
	});

	test('rejects a field outside the supported subset with a diagnostic', () => {
		const { error } = validateModel({ fields: { meta: { type: 'object' } } });
		expect(error?.name).toBe('UnsupportedShape');
		expect(error?.message).toMatch(/meta/);
		expect(error?.message).toMatch(/unsupported/);
	});
});

describe('parseModel (raw text)', () => {
	test('rejects invalid JSON with an error rather than throwing', () => {
		const { error } = parseModel('{ not json');
		expect(error?.name).toBe('InvalidJson');
		expect(error?.message).toMatch(/JSON/);
	});

	test('parses a valid file', () => {
		const { data, error } = parseModel('{"fields":{"title":{"type":"string"}}}');
		expect(error).toBeNull();
		expect(data?.fields).toHaveLength(1);
	});
});
