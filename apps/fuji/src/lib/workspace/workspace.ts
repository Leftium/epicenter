/**
 * Fuji workspace factory — creates a workspace client with domain actions.
 *
 * Actions package meaningful domain operations that go beyond raw table
 * CRUD. Simple single-table updates (pin, soft-delete, restore) stay in
 * the Svelte state files since they're one-liners against `tables.entries`.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, encryption, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createFujiWorkspace } from '@epicenter/fuji/workspace'
 *
 * const ws = createFujiWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * // Create an entry via action (CLI, AI, or UI)
 * ws.actions.entries.create({ title: 'My Post', tags: ['draft'] })
 * ```
 */

import {
	createWorkspace,
	DateTimeString,
	defineMutation,
	generateId,
} from '@epicenter/workspace';
import Type from 'typebox';
import { type EntryId, fujiWorkspace } from './definition';

export function createFujiWorkspace() {
	return createWorkspace(fujiWorkspace).withActions(({ tables }) => ({
		entries: {
			/**
			 * Create a new entry with sensible defaults.
			 *
			 * Generates a branded ID, sets timestamps, and returns the new ID
			 * so the caller can select it or navigate to it. Optional fields
			 * (title, subtitle, type, tags) default to empty values.
			 */
			create: defineMutation({
				title: 'Create Entry',
				description:
					'Create a new CMS entry with optional title, subtitle, type, and tags.',
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
				}),
				handler: ({ title, subtitle, type: entryType, tags }) => {
					const id = generateId() as unknown as EntryId;
					const now = DateTimeString.now();
					tables.entries.set({
						id,
						title: title ?? '',
						subtitle: subtitle ?? '',
						type: entryType ?? [],
						tags: tags ?? [],
						pinned: false,
						deletedAt: undefined,
						date: now,
						createdAt: now,
						updatedAt: now,
						_v: 1 as const,
					});
					return { id };
				},
			}),
		},
	}));
}
