import { describe, expect, test } from 'bun:test';
import { parseModel, validateModel } from './model';

describe('validateModel (the matter.json gate)', () => {
	test('accepts the supported subset and derives kinds in declared order', () => {
		const result = validateModel({
			fields: {
				title: { type: 'string' },
				status: { type: 'string', enum: ['draft', 'published'] },
				tags: { type: 'array', items: { type: 'string' } },
				url: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.model.fields.map((f) => [f.name, f.derived.kind, f.derived.nullable])).toEqual([
			['title', 'string', false],
			['status', 'enum', false],
			['tags', 'array', false],
			['url', 'url', true],
		]);
	});

	test('rejects a non-object top level', () => {
		expect(validateModel(42).ok).toBe(false);
		expect(validateModel(null).ok).toBe(false);
		expect(validateModel([]).ok).toBe(false);
	});

	test('rejects a missing fields object', () => {
		const r = validateModel({ views: {} });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected reject');
		expect(r.reason).toMatch(/fields/);
	});

	test('rejects a field that is not a schema object', () => {
		const r = validateModel({ fields: { title: 'string' } });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected reject');
		expect(r.reason).toMatch(/title/);
	});

	test('rejects a field outside the supported subset with a diagnostic', () => {
		const r = validateModel({ fields: { meta: { type: 'object' } } });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected reject');
		expect(r.reason).toMatch(/meta/);
		expect(r.reason).toMatch(/unsupported/);
	});
});

describe('parseModel (raw text)', () => {
	test('rejects invalid JSON with a reason rather than throwing', () => {
		const r = parseModel('{ not json');
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('expected reject');
		expect(r.reason).toMatch(/JSON/);
	});

	test('parses a valid file', () => {
		const r = parseModel('{"fields":{"title":{"type":"string"}}}');
		expect(r.ok).toBe(true);
	});
});
