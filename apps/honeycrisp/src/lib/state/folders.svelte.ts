/**
 * Reactive folder state for Honeycrisp.
 *
 * Manages folder CRUD operations and the reactive folder list. Backed by
 * a Y.Doc CRDT table, so folders sync across devices. Uses a factory
 * function pattern to encapsulate `$state`.
 *
 * Observers are registered once during factory construction and never
 * cleaned up (SPA lifetime).
 *
 * @example
 * ```svelte
 * <script>
 *   import { foldersState } from '$lib/state';
 * </script>
 *
 * {#each foldersState.folders as folder (folder.id)}
 *   <p>{folder.name}</p>
 * {/each}
 * <button onclick={() => foldersState.createFolder()}>New Folder</button>
 * ```
 */

import { generateId } from '@epicenter/workspace';
import workspaceClient, { type Folder, type FolderId } from '$lib/workspace';

function createFoldersState() {
	// ─── Reactive State ──────────────────────────────────────────────────

	/** Read all valid folders, used as initial seed + observer refresh. */
	const readFolders = () => workspaceClient.tables.folders.getAllValid();

	let folders = $state<Folder[]>(readFolders());

	// ─── Workspace Observers ─────────────────────────────────────────────

	const _unobserveFolders = workspaceClient.tables.folders.observe(() => {
		folders = readFolders();
	});

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		get folders() {
			return folders;
		},

		/**
		 * Create a new folder with the default name "New Folder".
		 *
		 * The folder is added to the end of the folder list and can be renamed
		 * immediately. Use this when the user clicks "New Folder" in the sidebar.
		 *
		 * @example
		 * ```typescript
		 * foldersState.createFolder();
		 * // Folder appears in sidebar with name "New Folder"
		 * ```
		 */
		createFolder() {
			const id = generateId() as string as FolderId;
			workspaceClient.tables.folders.set({
				id,
				name: 'New Folder',
				sortOrder: folders.length,
				_v: 1,
			});
		},

		/**
		 * Rename an existing folder.
		 *
		 * Updates the folder name in the sidebar and all references. The folder
		 * must exist; if it doesn't, the update is silently ignored.
		 *
		 * @example
		 * ```typescript
		 * foldersState.renameFolder(folderId, 'Work');
		 * ```
		 */
		renameFolder(folderId: FolderId, name: string) {
			workspaceClient.tables.folders.update(folderId, { name });
		},

		/**
		 * Delete a folder and move all its notes to unfiled.
		 *
		 * The folder is removed from the sidebar. All notes that were in this
		 * folder are moved to the unfiled section (folderId set to undefined).
		 * If the deleted folder was selected, the selection is cleared.
		 *
		 * @example
		 * ```typescript
		 * foldersState.deleteFolder(folderId);
		 * // Folder disappears from sidebar, its notes move to "All Notes"
		 * ```
		 */
		deleteFolder(folderId: FolderId) {
			const folderNotes = workspaceClient.tables.notes
				.getAllValid()
				.filter((n) => n.folderId === folderId);
			for (const note of folderNotes) {
				workspaceClient.tables.notes.update(note.id, {
					folderId: undefined,
				});
			}
			workspaceClient.tables.folders.delete(folderId);
			if (workspaceClient.kv.get('selectedFolderId') === folderId) {
				workspaceClient.kv.set('selectedFolderId', null);
			}
		},
	};
}

export const foldersState = createFoldersState();
