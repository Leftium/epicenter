/**
 * Fuji actions: typed query/mutation registry layered on the workspace tables.
 *
 * Split from `./workspace.ts` for navigation: workspace.ts owns schema + the
 * `createFujiWorkspace` factory; this file owns the action surface that the
 * browser and daemon expose over `openCollaboration` / `attachDaemonInfrastructure`.
 *
 * The `@epicenter/fuji` package re-exports `createFujiActions` and `FujiActions`
 * from `./workspace.ts` so external consumers keep importing from one place.
 */

import {
	column,
	DateTimeString,
	defineActions,
	defineMutation,
	defineQuery,
	generateId,
	type IanaTimeZone,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import { asEntryId, type EntryId, type FujiWorkspace } from './workspace';

export function createFujiActions(workspace: FujiWorkspace) {
	const { tables } = workspace;
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
			handler: () => {
				return tables.entries.getAllValid();
			},
		}),
		entries_count: defineQuery({
			title: 'Count Entries',
			description: 'Count entries in the daemon workspace.',
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
				dateZone: Type.Optional(
					Type.String({
						description:
							'IANA timezone the entry was authored in. Defaults to UTC.',
					}),
				),
			}),
			handler: ({
				title,
				subtitle,
				type: entryType,
				tags,
				rating,
				dateZone,
			}) => {
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
					deletedAt: null,
					date: now,
					dateZone: (dateZone ?? 'UTC') as IanaTimeZone,
					createdAt: now,
					updatedAt: now,
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
				deletedAt: column.nullable(
					column.dateTime({ description: 'Soft deletion timestamp' }),
				),
				date: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'User-defined date for the entry (UTC ISO 8601)',
				}),
				dateZone: Type.String({
					description: 'IANA timezone for displaying the entry date',
				}),
				createdAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Creation timestamp',
				}),
				updatedAt: Type.Unsafe<DateTimeString>({
					type: 'string',
					description: 'Last update timestamp',
				}),
			}),
			handler: (row) => {
				tables.entries.set({
					...row,
					id: asEntryId(row.id),
					dateZone: row.dateZone as IanaTimeZone,
				});
				return { id: row.id };
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
						description: 'User-defined date for the entry (UTC ISO 8601)',
					}),
				),
				dateZone: Type.Optional(
					Type.String({
						description: 'IANA timezone for displaying the entry date',
					}),
				),
			}),
			handler: ({ id, dateZone, ...fields }) => {
				return tables.entries.update(id, {
					...fields,
					...(dateZone !== undefined && {
						dateZone: dateZone as IanaTimeZone,
					}),
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
					deletedAt: null,
					updatedAt: DateTimeString.now(),
				});
			},
		}),
		entries_bulk_create: defineMutation({
			title: 'Bulk Create Entries',
			description:
				'Create multiple entries at once from title + (date, dateZone) pairs.',
			input: Type.Object({
				dateZone: Type.String({
					description:
						'IANA timezone the entries were authored in. Applied to every row.',
				}),
				entries: Type.Array(
					Type.Object({
						title: Type.String({ description: 'Entry title' }),
						date: Type.String({
							description: 'UTC ISO 8601 instant for the entry',
						}),
					}),
				),
			}),
			handler: async ({ dateZone, entries: items }) => {
				const now = DateTimeString.now();
				const rows = items.map(({ title, date }) => ({
					id: generateId<EntryId>(),
					title,
					subtitle: '',
					type: [] as string[],
					tags: [] as string[],
					pinned: false,
					rating: 0,
					deletedAt: null,
					date: date as DateTimeString,
					dateZone: dateZone as IanaTimeZone,
					createdAt: now,
					updatedAt: now,
				}));
				await tables.entries.bulkSet(rows);
				return { count: rows.length };
			},
		}),
	});
}

export type FujiActions = ReturnType<typeof createFujiActions>;
