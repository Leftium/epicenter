/**
 * Reactive view state for Fuji.
 *
 * Manages the current view mode, search query, and sort preference.
 * All persisted values use workspace KV so they survive reloads
 * and sync across devices.
 *
 * @example
 * ```svelte
 * <script>
 *   import { viewState } from '$lib/view.svelte';
 * </script>
 *
 * <button onclick={() => viewState.toggleViewMode()}>
 *   {viewState.viewMode === 'table' ? 'Timeline' : 'Table'}
 * </button>
 * ```
 */

import { fromKv } from '@epicenter/svelte';
import { workspace } from '$lib/client';

function createViewState() {
	// ─── KV-Backed State ──────────────────────────────────────────────────
	const viewModeKv = fromKv(workspace.kv, 'viewMode');
	const sortByKv = fromKv(workspace.kv, 'sortBy');

	// ─── Local State ─────────────────────────────────────────────────────
	let searchQuery = $state('');

	return {
		// ─── View Mode ───────────────────────────────────────────────────
		get viewMode(): 'table' | 'timeline' {
			return viewModeKv.current ?? 'table';
		},

		/**
		 * Toggle between table and timeline view modes.
		 *
		 * Persisted via workspace KV so the preference survives reloads
		 * and syncs across devices.
		 */
		toggleViewMode() {
			viewModeKv.current = viewModeKv.current === 'table' ? 'timeline' : 'table';
		},

		// ─── Sort ────────────────────────────────────────────────────────
		get sortBy(): 'date' | 'updatedAt' | 'createdAt' | 'title' {
			return sortByKv.current ?? 'date';
		},

		/**
		 * Set the sort preference. Persisted via workspace KV so it survives
		 * reloads and syncs across devices.
		 */
		set sortBy(value: 'date' | 'updatedAt' | 'createdAt' | 'title') {
			sortByKv.current = value;
		},


		get searchQuery() {
			return searchQuery;
		},

		/**
		 * Update the search query. Used by the sidebar search input.
		 */
		setSearchQuery(query: string) {
			searchQuery = query;
		},
	};
}

export const viewState = createViewState();
