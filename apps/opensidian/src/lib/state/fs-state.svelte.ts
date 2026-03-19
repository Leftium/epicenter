import type { FileId, FileRow } from '@epicenter/filesystem';
import { SvelteSet } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';
import { fs, ws } from '$lib/workspace';

/**
 * Interaction mode discriminated union.
 *
 * Only one interaction can be active at a time. Setting any mode
 * implicitly cancels the previous one—impossible states are unrepresentable.
 */
type InteractionMode =
	| { type: 'idle' }
	| { type: 'renaming'; targetId: FileId }
	| { type: 'creating'; parentId: FileId | null; fileType: 'file' | 'folder' }
	| { type: 'confirming-delete' };

/**
 * Reactive filesystem state singleton.
 *
 * Follows the tab-manager pattern: factory function creates all state,
 * exports a single const. Components import and read directly.
 *
 * Reactivity bridge: `FileSystemIndex` rebuilds itself on every table
 * mutation via its own observer. We layer a `version` counter ($state)
 * that bumps on every mutation (coalesced via rAF), which triggers
 * `$derived` recomputations that re-read from the already-updated index.
 *
 * @example
 * ```svelte
 * <script>
 *   import { fsState } from '$lib/state/fs-state.svelte';
 *   const children = $derived(fsState.rootChildIds);
 * </script>
 * ```
 */
function createFsState() {
	// ── Reactive state ────────────────────────────────────────────────
	let version = $state(0);
	let activeFileId = $state<FileId | null>(null);
	let openFileIds = $state<FileId[]>([]);
	const expandedIds = new SvelteSet<FileId>();
	let focusedId = $state<FileId | null>(null);

	// ── Interaction mode ─────────────────────────────────────────────
	// Replaces the old independent renamingId / inlineCreate / deleteDialogOpen
	// states. A single discriminated union prevents conflicting modes.
	let interactionMode = $state<InteractionMode>({ type: 'idle' });

	// ── Context menu hover persistence ───────────────────────────────
	// Tracks which tree item's context menu is currently open so the
	// item stays visually highlighted while the mouse is on the menu.
	let contextMenuTargetId = $state<FileId | null>(null);

	// ── rAF-coalesced observer ────────────────────────────────────────
	let pendingBump = false;
	const unobserve = ws.tables.files.observe(() => {
		if (!pendingBump) {
			pendingBump = true;
			requestAnimationFrame(() => {
				version++;
				pendingBump = false;
			});
		}
	});

	// ── Derived state ─────────────────────────────────────────────────

	/** Root-level child IDs — recomputes when version bumps. */
	const rootChildIds = $derived.by(() => {
		void version;
		return fs.index.getChildIds(null);
	});

	/** Full FileRow for the active file, or null. */
	const selectedNode = $derived.by(() => {
		void version;
		if (!activeFileId) return null;
		const result = ws.tables.files.get(activeFileId);
		return result.status === 'valid' ? result.row : null;
	});

	/**
	 * Path string for the active file (e.g. "/docs/api.md"), or null.
	 * Uses the index's O(1) reverse lookup.
	 */
	const selectedPath = $derived.by(() => {
		void version;
		if (!activeFileId) return null;
		return fs.index.getPathById(activeFileId) ?? null;
	});

	// ── Derived from interaction mode ────────────────────────────────
	// Stable public API over the internal union. Components read these
	// without coupling to InteractionMode's shape.

	const renamingId = $derived(
		interactionMode.type === 'renaming' ? interactionMode.targetId : null,
	);

	const inlineCreate = $derived(
		interactionMode.type === 'creating'
			? { parentId: interactionMode.parentId, type: interactionMode.fileType }
			: null,
	);

	const deleteDialogOpen = $derived(
		interactionMode.type === 'confirming-delete',
	);

	// ── Private helpers ───────────────────────────────────────────────

	/**
	 * Wrap an async operation with error toast handling.
	 * The callback contains all logic including success toasts.
	 * On error, shows the error's own message or the fallback.
	 */
	async function withErrorToast(
		fn: () => Promise<void>,
		fallbackMessage: string,
	) {
		try {
			await fn();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : fallbackMessage);
			console.error(err);
		}
	}

	const state = {
		// ── Read-only getters ───────────────────────────────────────
		get version() {
			return version;
		},
		get activeFileId() {
			return activeFileId;
		},
		get openFileIds() {
			return openFileIds;
		},
		get rootChildIds() {
			return rootChildIds;
		},
		get selectedNode() {
			return selectedNode;
		},
		get selectedPath() {
			return selectedPath;
		},
		get focusedId() {
			return focusedId;
		},
		get inlineCreate() {
			return inlineCreate;
		},
		get renamingId() {
			return renamingId;
		},
		get deleteDialogOpen() {
			return deleteDialogOpen;
		},
		get contextMenuTargetId() {
			return contextMenuTargetId;
		},

		expandedIds,

		/**
		 * Get child FileIds of a folder. Reads from FileSystemIndex.
		 * Must be called in a reactive context to track `version`.
		 */
		getChildIds(parentId: FileId | null) {
			void version;
			return fs.index.getChildIds(parentId);
		},

		/**
		 * Get the FileRow for a given ID.
		 * Returns null if the row is deleted/invalid.
		 */
		getRow(id: FileId): FileRow | null {
			void version;
			const result = ws.tables.files.get(id);
			return result.status === 'valid' ? result.row : null;
		},

		/**
		 * Find the path for a file ID using O(1) reverse index lookup.
		 * Returns null if not found (deleted/trashed).
		 */
		getPathForId(id: FileId): string | null {
			void version;
			return fs.index.getPathById(id) ?? null;
		},

		/**
		 * Walk the file tree recursively, calling `visitor` for each node.
		 *
		 * The visitor receives a file ID and its row, and returns an object:
		 * - `collect`: if present, the value is added to the result array
		 * - `descend`: if true, recurse into children (only meaningful for folders)
		 *
		 * Must be called in a reactive context to track `version`.
		 *
		 * @example
		 * ```typescript
		 * // Collect all visible IDs (respecting folder expansion)
		 * const visibleIds = fsState.walkTree((id, row) => ({
		 *   collect: id,
		 *   descend: row.type === 'folder' && fsState.expandedIds.has(id),
		 * }));
		 *
		 * // Collect only files with metadata
		 * const allFiles = fsState.walkTree((id, row) => {
		 *   if (row.type === 'file') return { collect: { id, name: row.name }, descend: false };
		 *   return { descend: true };
		 * });
		 * ```
		 */
		walkTree<T>(
			visitor: (id: FileId, row: FileRow) => { collect?: T; descend: boolean },
			parentId: FileId | null = null,
		): T[] {
			void version;
			const results: T[] = [];
			function walk(pid: FileId | null) {
				for (const childId of fs.index.getChildIds(pid)) {
					const result = ws.tables.files.get(childId);
					if (result.status !== 'valid' || result.row.trashedAt !== null)
						continue;
					const { collect, descend } = visitor(childId, result.row);
					if (collect !== undefined) results.push(collect);
					if (descend) walk(childId);
				}
			}
			walk(parentId);
			return results;
		},

		// ── Inline editing ───────────────────────────────────────────

		/**
		 * Begin inline creation. Shows an input in the tree at the target location.
		 * If a folder is focused, creates inside it. If a file is focused, creates as sibling.
		 * If nothing is focused, creates at root.
		 */
		startCreate(fileType: 'file' | 'folder') {
			const focused = focusedId ?? activeFileId;
			if (!focused) {
				interactionMode = { type: 'creating', parentId: null, fileType };
				return;
			}
			const row = state.getRow(focused);
			if (row?.type === 'folder') {
				expandedIds.add(focused);
				interactionMode = { type: 'creating', parentId: focused, fileType };
			} else if (row?.parentId) {
				interactionMode = {
					type: 'creating',
					parentId: row.parentId,
					fileType,
				};
			} else {
				interactionMode = { type: 'creating', parentId: null, fileType };
			}
		},

		cancelCreate() {
			interactionMode = { type: 'idle' };
		},

		async confirmCreate(name: string) {
			if (!name.trim() || interactionMode.type !== 'creating') return;
			const { parentId, fileType } = interactionMode;
			interactionMode = { type: 'idle' };
			if (fileType === 'file') {
				await state.createFile(parentId, name.trim());
			} else {
				await state.createFolder(parentId, name.trim());
			}
		},

		startRename(id: FileId) {
			interactionMode = { type: 'renaming', targetId: id };
		},

		cancelRename() {
			interactionMode = { type: 'idle' };
		},

		async confirmRename(newName: string) {
			if (!newName.trim() || interactionMode.type !== 'renaming') return;
			const id = interactionMode.targetId;
			interactionMode = { type: 'idle' };
			await state.rename(id, newName.trim());
		},

		// ── Delete dialog ────────────────────────────────────────────

		openDelete() {
			interactionMode = { type: 'confirming-delete' };
		},

		closeDelete() {
			interactionMode = { type: 'idle' };
		},

		// ── Context menu ─────────────────────────────────────────────

		setContextMenuTarget(id: FileId | null) {
			contextMenuTargetId = id;
		},

		// ── Actions ──────────────────────────────────────────────────

		selectFile(id: FileId) {
			activeFileId = id;
			if (!openFileIds.includes(id)) {
				openFileIds = [...openFileIds, id];
			}
		},

		closeFile(id: FileId) {
			openFileIds = openFileIds.filter((f) => f !== id);
			if (activeFileId === id) {
				activeFileId = openFileIds.at(-1) ?? null;
			}
		},

		toggleExpand(id: FileId) {
			if (expandedIds.has(id)) expandedIds.delete(id);
			else expandedIds.add(id);
		},

		focus(id: FileId | null) {
			focusedId = id;
		},

		async createFile(parentId: FileId | null, name: string) {
			await withErrorToast(async () => {
				const parentPath = parentId
					? (state.getPathForId(parentId) ?? '/')
					: '/';
				const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
				await fs.writeFile(path, '');
				toast.success(`Created ${path}`);
			}, 'Failed to create file');
		},

		async createFolder(parentId: FileId | null, name: string) {
			await withErrorToast(async () => {
				const parentPath = parentId
					? (state.getPathForId(parentId) ?? '/')
					: '/';
				const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
				await fs.mkdir(path);
				if (parentId) expandedIds.add(parentId);
				toast.success(`Created ${path}/`);
			}, 'Failed to create folder');
		},

		async deleteFile(id: FileId) {
			await withErrorToast(async () => {
				const path = state.getPathForId(id);
				if (!path) return;
				await fs.rm(path, { recursive: true });
				if (activeFileId === id) activeFileId = null;
				openFileIds = openFileIds.filter((f) => f !== id);
				toast.success(`Deleted ${path}`);
			}, 'Failed to delete');
		},

		async rename(id: FileId, newName: string) {
			await withErrorToast(async () => {
				const oldPath = state.getPathForId(id);
				if (!oldPath) return;
				const parentPath =
					oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
				const newPath =
					parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`;
				await fs.mv(oldPath, newPath);
				toast.success(`Renamed to ${newName}`);
			}, 'Failed to rename');
		},

		/**
		 * Read file content as string.
		 *
		 * Opens the per-file content Y.Doc and reads from the timeline.
		 */
		async readContent(id: FileId): Promise<string | null> {
			try {
				const handle = await ws.documents.files.content.open(id);
				return handle.read();
			} catch (err) {
				console.error('Failed to read content:', err);
				return null;
			}
		},

		/**
		 * Write file content as string.
		 *
		 * Opens the per-file content Y.Doc and writes to the timeline.
		 * The documents manager's `onUpdate` callback bumps `updatedAt` on the file row.
		 */
		async writeContent(id: FileId, data: string): Promise<void> {
			await withErrorToast(async () => {
				const handle = await ws.documents.files.content.open(id);
				handle.write(data);
			}, 'Failed to save file');
		},

		/** Cleanup — call from +layout.svelte onDestroy if needed. */
		async destroy() {
			unobserve();
			fs.index.destroy();
			await fs.destroy();
		},
	};

	return state;
}

export const fsState = createFsState();
