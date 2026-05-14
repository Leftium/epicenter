/**
 * Fuji workspace schema, branded IDs, and actions factory.
 *
 * Fuji is a personal CMS with a 1:1 mapping to your blog. Entries are content
 * pieces: articles, thoughts, ideas: organized by tags and type, displayed in a
 * data table with an editor panel. Each entry has a rich-text content document
 * for collaborative editing via ProseMirror + y-prosemirror.
 *
 * Distribution: this file is both the `@epicenter/fuji` npm root export AND
 * the `epicenter/fuji/workspace` jsrepo block. The table shapes here are the
 * wire contract for sync: forking a column shape breaks sync compatibility
 * with peers running the canonical schema. Recipes (script.ts, snapshot.ts,
 * daemon-route.ts) are yours to edit freely. See apps/README.md for the
 * dual-channel convention.
 */

import {
	DateTimeString,
	defineActions,
	defineMutation,
	defineQuery,
	defineTable,
	generateId,
	type InferTableRow,
	type Tables,
} from '@epicenter/workspace';
import { type } from 'arktype';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const FUJI_WORKSPACE_ID = 'epicenter.fuji';

export type EntryId = string & Brand<'EntryId'>;
export const EntryId = type('string').pipe((s): EntryId => s as EntryId);

const entriesTable = defineTable(
	type({
		id: EntryId,
		title: 'string',
		subtitle: 'string',
		type: 'string[]',
		tags: 'string[]',
		pinned: 'boolean',
		'deletedAt?': DateTimeString.or('undefined'),
		date: DateTimeString,
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '1',
	}),
	type({
		id: EntryId,
		title: 'string',
		subtitle: 'string',
		type: 'string[]',
		tags: 'string[]',
		pinned: 'boolean',
		rating: 'number',
		'deletedAt?': DateTimeString.or('undefined'),
		date: DateTimeString,
		createdAt: DateTimeString,
		updatedAt: DateTimeString,
		_v: '2',
	}),
).migrate((row) => {
	switch (row._v) {
		case 1:
			return { ...row, rating: 0, _v: 2 };
		case 2:
			return row;
	}
});

export type Entry = InferTableRow<typeof entriesTable>;

export const fujiTables = { entries: entriesTable };
export type FujiTables = Tables<typeof fujiTables>;

export function createFujiActions(tables: FujiTables) {
	return defineActions({
		entries_get: defineQuery({
			title: 'Get Entry',
			description: 'Read one entry by ID from the daemon workspace.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to read' }),
			}),
			handler: ({ id }) => {
				return tables.entries.get(id);
			},
		}),
		entries_get_all_valid: defineQuery({
			title: 'List Valid Entries',
			description: 'Read all valid entries from the daemon workspace.',
			input: Type.Object({}),
			handler: () => {
				return tables.entries.getAllValid();
			},
		}),
		entries_count: defineQuery({
			title: 'Count Entries',
			description: 'Count entries in the daemon workspace.',
			input: Type.Object({}),
			handler: () => {
				return tables.entries.count();
			},
		}),
		entries_has: defineQuery({
			title: 'Has Entry',
			description: 'Check whether an entry exists in the daemon workspace.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to check' }),
			}),
			handler: ({ id }) => {
				return tables.entries.has(id);
			},
		}),
		entries_create: defineMutation({
			title: 'Create Entry',
			description:
				'Create a new CMS entry with optional title, subtitle, type, tags, and rating.',
			input: Type.Object({
				title: Type.Optional(Type.String({ description: 'Entry title' })),
				subtitle: Type.Optional(
					Type.String({ description: 'Subtitle for blog listings' }),
				),
				type: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Type classifications',
					}),
				),
				tags: Type.Optional(
					Type.Array(Type.String(), { description: 'Freeform tags' }),
				),
				rating: Type.Optional(
					Type.Number({ description: 'Rating from 0-5 (0 = unrated)' }),
				),
			}),
			handler: ({ title, subtitle, type: entryType, tags, rating }) => {
				const id = generateId<EntryId>();
				const now = DateTimeString.now();
				tables.entries.set({
					id,
					title: title ?? '',
					subtitle: subtitle ?? '',
					type: entryType ?? [],
					tags: tags ?? [],
					pinned: false,
					rating: rating ?? 0,
					deletedAt: undefined,
					date: now,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				});
				return { id };
			},
		}),
		entries_upsert: defineMutation({
			title: 'Upsert Entry',
			description: 'Insert or replace a full entry row.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID' }),
				title: Type.String({ description: 'Entry title' }),
				subtitle: Type.String({ description: 'Subtitle for blog listings' }),
				type: Type.Array(Type.String(), {
					description: 'Type classifications',
				}),
				tags: Type.Array(Type.String(), { description: 'Freeform tags' }),
				pinned: Type.Boolean({ description: 'Whether the entry is pinned' }),
				rating: Type.Number({ description: 'Rating from 0 to 5' }),
				deletedAt: Type.Optional(
					Type.Unsafe<DateTimeString>({
						type: 'string',
						description: 'Soft deletion timestamp',
					}),
				),
				date: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'User-defined date for the entry',
				}),
				createdAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Creation timestamp',
				}),
				updatedAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Last update timestamp',
				}),
				_v: Type.Literal(2),
			}),
			handler: (row) => {
				const parsed = tables.entries.parse(row.id, row);
				if (parsed.error) throw parsed.error;
				tables.entries.set(parsed.data);
				return { id: parsed.data.id };
			},
		}),
		entries_update: defineMutation({
			title: 'Update Entry',
			description:
				'Update entry metadata fields. Automatically bumps updatedAt.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to update' }),
				title: Type.Optional(Type.String({ description: 'Entry title' })),
				subtitle: Type.Optional(
					Type.String({ description: 'Subtitle for blog listings' }),
				),
				type: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Type classifications',
					}),
				),
				tags: Type.Optional(
					Type.Array(Type.String(), { description: 'Freeform tags' }),
				),
				rating: Type.Optional(
					Type.Number({ description: 'Rating from 0-5 (0 = unrated)' }),
				),
				date: Type.Optional(
					Type.Unsafe<DateTimeString>({
						type: 'string',
						description: 'User-defined date for the entry',
					}),
				),
			}),
			handler: ({ id, ...fields }) => {
				return tables.entries.update(id, {
					...fields,
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_delete: defineMutation({
			title: 'Delete Entry',
			description: 'Soft-delete an entry by setting deletedAt to now.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to soft-delete' }),
			}),
			handler: ({ id }) => {
				return tables.entries.update(id, {
					deletedAt: DateTimeString.now(),
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_restore: defineMutation({
			title: 'Restore Entry',
			description: 'Restore a soft-deleted entry by clearing deletedAt.',
			input: Type.Object({
				id: Type.String({ description: 'Entry ID to restore' }),
			}),
			handler: ({ id }) => {
				return tables.entries.update(id, {
					deletedAt: undefined,
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_bulk_create: defineMutation({
			title: 'Bulk Create Entries',
			description: 'Create multiple entries at once from title + date pairs.',
			input: Type.Object({
				entries: Type.Array(
					Type.Object({
						title: Type.String({ description: 'Entry title' }),
						date: Type.String({
							description: 'ISO date string in workspace DateTimeString format',
						}),
					}),
				),
			}),
			handler: async ({ entries: items }) => {
				const now = DateTimeString.now();
				const rows = items.map(({ title, date }) => ({
					id: generateId<EntryId>(),
					title,
					subtitle: '',
					type: [] as string[],
					tags: [] as string[],
					pinned: false,
					rating: 0,
					deletedAt: undefined,
					date: date as DateTimeString,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				}));
				await tables.entries.bulkSet(rows);
				return { count: rows.length };
			},
		}),
	});
}

export type FujiActions = ReturnType<typeof createFujiActions>;
