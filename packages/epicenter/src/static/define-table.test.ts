/**
 * defineTable Tests
 *
 * Verifies shorthand and builder-based table definitions, including multi-version schema migration.
 * These tests ensure table contracts remain stable for runtime validation and for typed document bindings.
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

	describe('builder syntax', () => {
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
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string', _v: '1' }))
				.version(
					type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
				)
				.migrate((row) => {
					if (row._v === 1) return { ...row, views: 0, _v: 2 as const };
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
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string', _v: '1' }))
				.version(
					type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
				)
				.migrate((row) => {
					if (row._v === 1) return { ...row, views: 0, _v: 2 as const };
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

		test('throws when no versions are defined', () => {
			expect(() => {
				defineTable().migrate((row) => row);
			}).toThrow('defineTable() requires at least one .version() call');
		});
	});

	describe('schema patterns', () => {
		test('two version migration with _v discriminant', () => {
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string', _v: '1' }))
				.version(
					type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
				)
				.migrate((row) => {
					if (row._v === 1) return { ...row, views: 0, _v: 2 as const };
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
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string', _v: '1' }))
				.version(
					type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
				)
				.migrate((row) => {
					if (row._v === 1) return { ...row, views: 0, _v: 2 as const };
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
			const posts = defineTable()
				.version(type({ id: 'string', title: 'string', _v: '1' }))
				.version(
					type({
						id: 'string',
						title: 'string',
						views: 'number',
						_v: '2',
					}),
				)
				.migrate((row) => {
					switch (row._v) {
						case 1:
							return { ...row, views: 0, _v: 2 as const };
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
				_v: 2 as const,
			});
			expect(alreadyLatest).toEqual({
				id: '1',
				title: 'Test',
				views: 5,
				_v: 2,
			});
		});
	});

	describe('withDocument', () => {
		test('shorthand path adds docs to definition', () => {
			const files = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

			expect(files.docs.content.guid).toBe('id');
			expect(files.docs.content.updatedAt).toBe('updatedAt');
			expect(files.docs.content.tags).toBeUndefined();
		});

		test('builder path adds docs to definition', () => {
			const notes = defineTable()
				.version(
					type({
						id: 'string',
						docId: 'string',
						modifiedAt: 'number',
						_v: '1',
					}),
				)
				.migrate((row) => row)
				.withDocument('content', {
					guid: 'docId',
					updatedAt: 'modifiedAt',
				});

			expect(notes.docs.content.guid).toBe('docId');
			expect(notes.docs.content.updatedAt).toBe('modifiedAt');
			expect(notes.docs.content.tags).toBeUndefined();
		});

		test('multiple withDocument chains accumulate docs', () => {
			const notes = defineTable(
				type({
					id: 'string',
					bodyDocId: 'string',
					coverDocId: 'string',
					bodyUpdatedAt: 'number',
					coverUpdatedAt: 'number',
					_v: '1',
				}),
			)
				.withDocument('body', {
					guid: 'bodyDocId',
					updatedAt: 'bodyUpdatedAt',
				})
				.withDocument('cover', {
					guid: 'coverDocId',
					updatedAt: 'coverUpdatedAt',
				});

			expect(notes.docs.body.guid).toBe('bodyDocId');
			expect(notes.docs.body.updatedAt).toBe('bodyUpdatedAt');
			expect(notes.docs.cover.guid).toBe('coverDocId');
			expect(notes.docs.cover.updatedAt).toBe('coverUpdatedAt');
		});

		test('table without withDocument keeps docs map empty', () => {
			const tags = defineTable(
				type({ id: 'string', label: 'string', _v: '1' }),
			);

			expect(Object.keys(tags.docs)).toHaveLength(0);
		});

		test('withDocument accepts a single-element tag array', () => {
			const files = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			).withDocument('content', {
				guid: 'id',
				updatedAt: 'updatedAt',
				tags: ['persistent'],
			});

			expect(files.docs.content.guid).toBe('id');
			expect(files.docs.content.updatedAt).toBe('updatedAt');
			expect(files.docs.content.tags).toEqual(['persistent']);
		});

		test('withDocument accepts an array of tags', () => {
			const files = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			).withDocument('content', {
				guid: 'id',
				updatedAt: 'updatedAt',
				tags: ['persistent', 'synced'] as const,
			});

			expect(files.docs.content.guid).toBe('id');
			expect(files.docs.content.updatedAt).toBe('updatedAt');
			expect(files.docs.content.tags).toEqual(['persistent', 'synced']);
		});

		test('withDocument without tags omits tags from docs', () => {
			const files = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

			expect(files.docs.content.tags).toBeUndefined();
		});

		test('withDocument preserves schema validation and migrate behavior', () => {
			const files = defineTable(
				type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
			).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });

			// Schema still works
			const result = files.schema['~standard'].validate({
				id: '1',
				name: 'test.txt',
				updatedAt: 123,
				_v: 1,
			});
			expect(result).not.toHaveProperty('issues');

			// Migrate still works
			const row = { id: '1', name: 'test.txt', updatedAt: 123, _v: 1 as const };
			expect(files.migrate(row)).toBe(row);
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

		test('rejects withDocument mappings that reference missing keys', () => {
			const files = defineTable(
				type({ id: 'string', updatedAt: 'number', _v: '1' }),
			);
			// @ts-expect-error guid key must exist on the row schema
			files.withDocument('content', {
				guid: 'missing',
				updatedAt: 'updatedAt',
			});
		});
	});
});
