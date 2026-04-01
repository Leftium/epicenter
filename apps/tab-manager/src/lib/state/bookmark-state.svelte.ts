/**
 * Reactive bookmark state for the side panel.
 *
 * Read-only reactive layer backed by `fromTable()` — provides granular
 * per-row reactivity via `SvelteMap`. All write operations are delegated
 * to workspace actions defined in `client.ts`.
 *
 * The public API exposes a `$derived` sorted array (access pattern is
 * always "render the full sorted list") plus a URL lookup set for O(1)
 * bookmark checks.
 *
 * @example
 * ```svelte
 * <script>
 *   import { bookmarkState } from '$lib/state/bookmark-state.svelte';
 * </script>
 *
 * {#each bookmarkState.bookmarks as bookmark (bookmark.id)}
 *   <BookmarkItem {bookmark} />
 * {/each}
 *
 * <button onclick={() => bookmarkState.toggle(tab)}>
 *   {bookmarkState.isUrlBookmarked(tab.url) ? 'Unbookmark' : 'Bookmark'}
 * </button>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { SvelteSet } from 'svelte/reactivity';
import { workspace } from '$lib/client';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { Bookmark, BookmarkId } from '$lib/workspace';

function createBookmarkState() {
	const bookmarksMap = fromTable(workspace.tables.bookmarks);

	/** All bookmarks, sorted by most recently created first. Cached via $derived. */
	const bookmarks = $derived(
		bookmarksMap
			.values()
			.toArray()
			.sort((a, b) => b.createdAt - a.createdAt),
	);

	/**
	 * Reactive set of bookmarked URLs for O(1) lookup.
	 *
	 * Uses `SvelteSet` so `.has()` is a tracked reactive read—Svelte 5
	 * re-renders any component that calls `isUrlBookmarked` when the set changes.
	 */
	const bookmarkedUrls = $derived(
		new SvelteSet(bookmarksMap.values().map((b) => b.url)),
	);
	return {
		get bookmarks() {
			return bookmarks;
		},

		/**
		 * Check whether a URL is currently bookmarked.
		 *
		 * O(1) lookup via `SvelteSet.has()`, which is a tracked reactive
		 * read in Svelte 5—safe to call per-row in a list render.
		 */
		isUrlBookmarked(url: string | undefined): boolean {
			if (!url) return false;
			return bookmarkedUrls.has(url);
		},

		/**
		 * Toggle a bookmark for a tab—add if not bookmarked, remove if already bookmarked.
		 *
		 * Delegates to the `bookmarks.toggle` workspace action so the operation
		 * is AI-callable and follows the same code path as programmatic toggles.
		 * Silently no-ops for tabs without a URL.
		 */
		async toggle(tab: BrowserTab) {
			if (!tab.url) return;
			await workspace.actions.bookmarks.toggle({
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
			});
		},

		/**
		 * Open a bookmark in a new browser tab without removing the bookmark.
		 *
		 * Delegates to the `bookmarks.open` workspace action.
		 */
		async open(bookmark: Bookmark) {
			await workspace.actions.bookmarks.open({ url: bookmark.url });
		},

		/**
		 * Delete a bookmark by ID.
		 *
		 * Delegates to the `bookmarks.remove` workspace action.
		 */
		async remove(id: BookmarkId) {
			await workspace.actions.bookmarks.remove({ id });
		},

		/**
		 * Delete all bookmarks.
		 *
		 * Delegates to the `bookmarks.removeAll` workspace action.
		 */
		async removeAll() {
			await workspace.actions.bookmarks.removeAll({});
		},
	};
}

export const bookmarkState = createBookmarkState();
