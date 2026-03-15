/**
 * Reactive transformation state backed by Yjs workspace tables.
 *
 * Replaces TanStack Query + DbService for transformation CRUD. The workspace
 * model stores transformations as metadata rows (title, description, timestamps)
 * without embedded steps—steps live in a separate `transformationSteps` table.
 *
 * @example
 * ```typescript
 * import { workspaceTransformations } from '$lib/state/workspace-transformations.svelte';
 *
 * // Read reactively
 * const transformation = workspaceTransformations.get(id);
 * const all = workspaceTransformations.sorted; // alphabetical by title
 *
 * // Write
 * workspaceTransformations.set(transformation);
 * workspaceTransformations.delete(id);
 * ```
 */
import { SvelteMap } from 'svelte/reactivity';
import workspace from '$lib/workspace';

/** Transformation row type inferred from the workspace table schema. */
export type Transformation = ReturnType<
	typeof workspace.tables.transformations.getAllValid
>[number];

function createWorkspaceTransformations() {
	const map = new SvelteMap<string, Transformation>();

	// Initialize from current workspace state.
	for (const row of workspace.tables.transformations.getAllValid()) {
		map.set(row.id, row);
	}

	// Observe all changes (local writes, remote CRDT sync, migration).
	workspace.tables.transformations.observe((changedIds) => {
		for (const id of changedIds) {
			const result = workspace.tables.transformations.get(id);
			if (result.status === 'valid') {
				map.set(id, result.row);
			} else if (result.status === 'not_found') {
				map.delete(id);
			}
		}
	});

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title)),
	);

	return {
		/**
		 * All transformations as a reactive SvelteMap.
		 *
		 * Components reading this re-render per-key when transformations change.
		 */
		get all() {
			return map;
		},

		/**
		 * Get a transformation by ID. Returns undefined if not found.
		 */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * All transformations as a sorted array (alphabetical by title).
		 * Memoized via `$derived`—stable reference until SvelteMap changes.
		 */
		get sorted(): Transformation[] {
			return sorted;
		},

		/**
		 * Create or update a transformation. Writes to Yjs → observer updates SvelteMap.
		 *
		 * Accepts a transformation without `_v` (version tag is added automatically).
		 */
		set(transformation: Omit<Transformation, '_v'>) {
			workspace.tables.transformations.set({
				...transformation,
				_v: 1,
			} as Transformation);
		},

		/**
		 * Partially update a transformation by ID.
		 */
		update(id: string, partial: Partial<Omit<Transformation, 'id' | '_v'>>) {
			return workspace.tables.transformations.update(id, partial);
		},

		/**
		 * Delete a transformation by ID.
		 */
		delete(id: string) {
			workspace.tables.transformations.delete(id);
		},

		/** Total number of transformations. */
		get count() {
			return map.size;
		},
	};
}

export const workspaceTransformations = createWorkspaceTransformations();
