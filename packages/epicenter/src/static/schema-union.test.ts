import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { createUnionSchema } from './schema-union.js';

describe('createUnionSchema', () => {
	test('validates against first matching schema', () => {
		const v1 = type({ id: 'string', title: 'string' });
		const v2 = type({ id: 'string', title: 'string', views: 'number' });

		const union = createUnionSchema([v1, v2]);
		const result = union['~standard'].validate({ id: '1', title: 'Hello' });

		expect(result).not.toHaveProperty('issues');
		if (!result.issues) {
			expect(result.value).toEqual({ id: '1', title: 'Hello' });
		}
	});

	test('validates against second schema when first fails', () => {
		const v1 = type({ id: 'string', title: 'string' });
		const v2 = type({ id: 'string', title: 'string', views: 'number' });

		const union = createUnionSchema([v1, v2]);
		const result = union['~standard'].validate({
			id: '1',
			title: 'Hello',
			views: 42,
		});

		expect(result).not.toHaveProperty('issues');
	});

	test('returns error when no schema matches', () => {
		const v1 = type({ id: 'string', title: 'string' });

		const union = createUnionSchema([v1]);
		const result = union['~standard'].validate({ id: 123 }); // id should be string

		expect(result.issues?.length).toBeGreaterThan(0);
	});

	test('throws when schema validation is async', () => {
		const asyncSchema = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: () => Promise.resolve({ value: {} }),
			},
		} satisfies StandardSchemaV1;

		const union = createUnionSchema([asyncSchema]);

		expect(() => union['~standard'].validate({})).toThrow(
			'Schema validation must be synchronous',
		);
	});
});
