/**
 * Reactive view state for Fuji.
 *
 * Manages the current view mode, selected entry, sidebar filters, and
 * search query. All persisted values use workspace KV so they survive
 * reloads and sync across devices.
 *
 * @example
 * ```svelte
 * <script>
 *   import { viewState } from '$lib/state/view-state.svelte';
 * </script>
 *
 * <button onclick={() => viewState.toggleViewMode()}>
 *   {viewState.viewMode === 'table' ? 'Timeline' : 'Table'}
 * </button>
 * ```
 */

import { fromKv } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { EntryId } from '$lib/workspace';

function createViewState() {
	// ─── KV-Backed State ──────────────────────────────────────────────────
	const selectedEntryIdKv = fromKv(workspace.kv, 'selectedEntryId');
	const viewModeKv = fromKv(workspace.kv, 'viewMode');
	const sidebarCollapsedKv = fromKv(workspace.kv, 'sidebarCollapsed');

	// ─── Local State ─────────────────────────────────────────────────────
	let activeTypeFilter = $state<string | null>(null);
	let activeTagFilter = $state<string | null>(null);
	let searchQuery = $state('');

	return {
		// ─── Selected Entry ──────────────────────────────────────────────
		get selectedEntryId(): EntryId | null {
			return selectedEntryIdKv.current ?? null;
		},

		/**
		 * Select an entry by ID, or pass null to deselect.
		 *
		 * The selected entry determines which entry is shown in the editor
		 * panel. Persisted via workspace KV.
		 */
		selectEntry(id: EntryId | null) {
			selectedEntryIdKv.current = id;
		},

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

		// ─── Sidebar ─────────────────────────────────────────────────────
		get sidebarCollapsed(): boolean {
			return sidebarCollapsedKv.current ?? false;
		},

		set sidebarCollapsed(value: boolean) {
			sidebarCollapsedKv.current = value;
		},

		// ─── Filters ─────────────────────────────────────────────────────
		get activeTypeFilter() {
			return activeTypeFilter;
		},

		get activeTagFilter() {
			return activeTagFilter;
		},

		get searchQuery() {
			return searchQuery;
		},

		/**
		 * Filter entries by type. Pass null to clear the filter.
		 * Clicking the same type again clears it (toggle behavior).
		 */
		filterByType(type: string | null) {
			activeTypeFilter = type;
		},

		/**
		 * Filter entries by tag. Pass null to clear the filter.
		 * Clicking the same tag again clears it (toggle behavior).
		 */
		filterByTag(tag: string | null) {
			activeTagFilter = tag;
		},

		/**
		 * Update the search query. Used by the sidebar search input and
		 * the command palette.
		 */
		setSearchQuery(query: string) {
			searchQuery = query;
		},

		/**
		 * Clear all active filters and search query.
		 */
		clearFilters() {
			activeTypeFilter = null;
			activeTagFilter = null;
			searchQuery = '';
		},
	};
}

export const viewState = createViewState();
