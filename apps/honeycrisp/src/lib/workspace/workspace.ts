/**
 * Honeycrisp workspace factory — creates a workspace client with domain actions.
 *
 * Includes cross-table mutations (e.g. folder deletion with note re-parenting)
 * that touch multiple tables in a single logical operation. Simple
 * single-table CRUD stays in the Svelte state files.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, encryption, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createHoneycrisp } from '@epicenter/honeycrisp/workspace'
 *
 * const ws = createHoneycrisp()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * // Multi-table mutation via actions
 * ws.actions.folders.delete({ folderId: 'abc' })
 * ```
 */

import { createWorkspace, defineMutation } from '@epicenter/workspace';
import Type from 'typebox';
import { definition, type FolderId } from './definition';

export function createHoneycrisp() {
	return createWorkspace(definition).withActions(({ tables }) => ({
		folders: {
			/**
			 * Delete a folder and move all its notes to unfiled.
			 *
			 * Re-parents every note in the folder (sets `folderId` to undefined)
			 * and deletes the folder row. Selection clearing is handled by the
			 * Svelte state layer (foldersState) via URL search params.
			 */
			delete: defineMutation({
				description: 'Delete a folder and re-parent its notes to unfiled',
				input: Type.Object({ folderId: Type.String() }),
				handler: ({ folderId: rawId }) => {
					const folderId = rawId as FolderId;
					const folderNotes = tables.notes
						.getAllValid()
						.filter((n) => n.folderId === folderId);
					for (const note of folderNotes) {
						tables.notes.update(note.id, { folderId: undefined });
					}
					tables.folders.delete(folderId);
				},
			}),
		},
	}));
}
