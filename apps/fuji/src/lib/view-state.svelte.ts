/**
 * Reactive Fuji view preferences.
 *
 * Holds persisted UI choices like view mode, sort order, and search query.
 * The entry collection and search helpers live in `entries-state.svelte.ts`.
 */

import { fromKv } from '@epicenter/svelte';
import { workspace } from '$lib/client';

function createViewState() {
	const viewModeKv = fromKv(workspace.kv, 'viewMode');
	const sortByKv = fromKv(workspace.kv, 'sortBy');
	let searchQuery = $state('');

	return {
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
			viewModeKv.current =
				viewModeKv.current === 'table' ? 'timeline' : 'table';
		},

		get sortBy(): 'date' | 'updatedAt' | 'createdAt' | 'title' | 'rating' {
			return sortByKv.current ?? 'date';
		},

		/**
		 * Set the sort preference. Persisted via workspace KV so it survives
		 * reloads and syncs across devices.
		 */
		set sortBy(value: 'date' | 'updatedAt' | 'createdAt' | 'title' | 'rating') {
			sortByKv.current = value;
		},

		get searchQuery() {
			return searchQuery;
		},

		/** Update the search query. Used by the sidebar search input. */
		set searchQuery(value: string) {
			searchQuery = value;
		},
	};
}

export const viewState = createViewState();
