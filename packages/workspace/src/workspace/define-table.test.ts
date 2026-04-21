/**
 * defineTable Tests
 *
 * Verifies single-schema and variadic multi-version table definitions, including schema migration.
 * These tests ensure table contracts remain stable for runtime validation and for typed documents.
 *
 * Key behaviors:
 * - Table schemas validate expected row shapes across versions.
 * - Migration functions upgrade legacy rows to the latest schema.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineTable } from './define-table.js';

describe('defineTable', () => {
	describe('shorthand syntax', () => {
		test('creates valid table definition with direct schema', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);

			// Verify schema validates correctly
			const result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Hello',
				_v: 1,
			});
			expect(result).not.toHaveProperty('issues');
		});

		test('shorthand migrate returns the same row reference', () => {
			const users = defineTable(
				type({ id: 'string', email: 'string', _v: '1' }),
			);

			const row = { id: '1', email: 'test@example.com', _v: 1 as const };
			expect(users.migrate(row)).toBe(row);
		});

		test('shorthand produces equivalent validation to builder pattern', () => {
			const schema = type({ id: 'string', title: 'string', _v: '1' });

			const shorthand = defineTable(schema);
			const builder = defineTable(schema);

			// Both should validate the same data
			const testRow = { id: '1', title: 'Test', _v: 1 };
			const shorthandResult = shorthand.schema['~standard'].validate(testRow);
			const builderResult = builder.schema['~standard'].validate(testRow);

			expect(shorthandResult).not.toHaveProperty('issues');
			expect(builderResult).not.toHaveProperty('issues');
		});
	});

	describe('variadic syntax', () => {
		test('creates valid table definition with single version', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);

			const result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Hello',
				_v: 1,
			});
			expect(result).not.toHaveProperty('issues');
		});

		test('creates table definition with multiple versions that validates both', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, views: 0, _v: 2 };
				return row;
			});

			// V1 data should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(v1Result).not.toHaveProperty('issues');

			// V2 data should validate
			const v2Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				views: 10,
				_v: 2,
			});
			expect(v2Result).not.toHaveProperty('issues');
		});

		test('migrate function upgrades old rows to latest version', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, views: 0, _v: 2 };
				return row;
			});

			// Migrate v1 to v2
			const migrated = posts.migrate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(migrated).toEqual({ id: '1', title: 'Test', views: 0, _v: 2 });
		});

		test('requires at least one schema argument', () => {
			expect(() => {
				// @ts-expect-error no arguments provided
				defineTable();
			}).toThrow();
		});
	});

	describe('schema patterns', () => {
		test('two version migration with _v discriminant', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, views: 0, _v: 2 };
				return row;
			});

			// Both versions should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(v1Result).not.toHaveProperty('issues');

			const migrated = posts.migrate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(migrated).toEqual({ id: '1', title: 'Test', views: 0, _v: 2 });
		});

		test('two version migration with _v', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
			).migrate((row) => {
				if (row._v === 1) return { ...row, views: 0, _v: 2 };
				return row;
			});

			// Both versions should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(v1Result).not.toHaveProperty('issues');

			const v2Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				views: 10,
				_v: 2,
			});
			expect(v2Result).not.toHaveProperty('issues');

			// Migrate v1 to v2
			const migrated = posts.migrate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(migrated).toEqual({ id: '1', title: 'Test', views: 0, _v: 2 });
		});

		test('three-version migration uses switch and preserves latest rows', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
				type({
					id: 'string',
					title: 'string',
					views: 'number',
					_v: '2',
				}),
			).migrate((row) => {
				switch (row._v) {
					case 1:
						return { ...row, views: 0, _v: 2 };
					case 2:
						return row;
				}
			});

			// V1 data should validate
			const v1Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(v1Result).not.toHaveProperty('issues');

			// V2 data should validate
			const v2Result = posts.schema['~standard'].validate({
				id: '1',
				title: 'Test',
				views: 10,
				_v: 2,
			});
			expect(v2Result).not.toHaveProperty('issues');

			// Migrate v1 to v2
			const migrated = posts.migrate({
				id: '1',
				title: 'Test',
				_v: 1,
			});
			expect(migrated).toEqual({
				id: '1',
				title: 'Test',
				views: 0,
				_v: 2,
			});

			// V2 passes through unchanged
			const alreadyLatest = posts.migrate({
				id: '1',
				title: 'Test',
				views: 5,
				_v: 2,
			});
			expect(alreadyLatest).toEqual({
				id: '1',
				title: 'Test',
				views: 5,
				_v: 2,
			});
		});
	});

	describe('type errors', () => {
		test('rejects migrate input missing required fields', () => {
			const posts = defineTable(
				type({ id: 'string', title: 'string', _v: '1' }),
			);

			// @ts-expect-error title is required by the row schema
			const _invalidRow: Parameters<typeof posts.migrate>[0] = {
				id: '1',
				_v: 1,
			};
			void _invalidRow;
		});
	});
});
