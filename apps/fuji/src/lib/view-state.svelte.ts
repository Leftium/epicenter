/**
 * Reactive Fuji view preferences backed by URL search params.
 *
 * View mode, sort order, and search query live in the URL so they're
 * bookmarkable, shareable, and work with browser back/forward.
 * Default values are elided from the URL to keep it clean—`/` means
 * table view, sorted by date, no search.
 *
 * The entry collection and search helpers live in `entries-state.svelte.ts`.
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';

type ViewMode = 'table' | 'timeline';
type SortBy = 'date' | 'updatedAt' | 'createdAt' | 'title' | 'rating';

/** Update a single URL search param, removing it when null to keep URLs clean. */
function setSearchParam(key: string, value: string | null) {
	const params = new URLSearchParams(page.url.searchParams);
	if (value === null) {
		params.delete(key);
	} else {
		params.set(key, value);
	}
	const search = params.toString();
	goto(`${page.url.pathname}${search ? `?${search}` : ''}${page.url.hash}`, {
		replaceState: true,
		noScroll: true,
		keepFocus: true,
	});
}

function createViewState() {
	return {
		get viewMode(): ViewMode {
			return (page.url.searchParams.get('view') as ViewMode) ?? 'table';
		},

		/**
		 * Toggle between table and timeline view modes.
		 *
		 * Updates the `view` search param. Default ('table') is elided
		 * from the URL so `/` always means table view.
		 */
		toggleViewMode() {
			const next: ViewMode = this.viewMode === 'table' ? 'timeline' : 'table';
			setSearchParam('view', next === 'table' ? null : next);
		},

		get sortBy(): SortBy {
			return (page.url.searchParams.get('sort') as SortBy) ?? 'date';
		},

		/**
		 * Set the sort preference via the `sort` search param.
		 * Default ('date') is elided to keep URLs clean.
		 */
		set sortBy(value: SortBy) {
			setSearchParam('sort', value === 'date' ? null : value);
		},

		get searchQuery() {
			return page.url.searchParams.get('q') ?? '';
		},

		/** Update the search query via the `q` search param. Empty values are elided. */
		set searchQuery(value: string) {
			setSearchParam('q', value || null);
		},
	};
}

export const viewState = createViewState();
