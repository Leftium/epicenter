/**
 * Reactive bookmark state for the side panel.
 *
 * Backed by a Y.Doc CRDT table, so bookmarks sync across devices and survive
 * browser restarts. Unlike saved tabs (which are consumed on restore),
 * bookmarks persist indefinitely—opening a bookmarked URL does NOT delete
 * the record.
 *
 * Uses a plain `$state` array (not `SvelteMap`) because the access pattern is
 * always "render the full sorted list." The Y.Doc observer wholesale-replaces
 * the array on every change, identical to {@link savedTabState}.
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
 * <button onclick={() => bookmarkState.add(tab)}>
 *   Bookmark
 * </button>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { getDeviceId } from '$lib/device/device-id';
import {
	type Bookmark,
	type BookmarkId,
	generateBookmarkId,
	type Tab,
	workspaceClient,
} from '$lib/workspace';

function createBookmarkState() {
	const bookmarksMap = fromTable(workspaceClient.tables.bookmarks);

	/** All bookmarks, sorted by most recently created first. Cached via $derived. */
	const bookmarks = $derived(
		bookmarksMap
			.values()
			.toArray()
			.sort((a, b) => b.createdAt - a.createdAt),
	);

	return {
		get bookmarks() {
			return bookmarks;
		},

		/**
		 * Bookmark a tab—snapshot its metadata to Y.Doc.
		 *
		 * Unlike "save for later," this does NOT close the browser tab.
		 * The bookmark persists until explicitly deleted.
		 *
		 * Silently no-ops for tabs without a URL.
		 */
		async add(tab: Tab) {
			if (!tab.url) return;
			const deviceId = await getDeviceId();
			workspaceClient.tables.bookmarks.set({
				id: generateBookmarkId(),
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
				description: undefined,
				sourceDeviceId: deviceId,
				createdAt: Date.now(),
				_v: 1,
			});
		},

		/**
		 * Open a bookmark in a new browser tab.
		 *
		 * Unlike saved tab restore, the bookmark record is NOT deleted.
		 */
		async open(bookmark: Bookmark) {
			await browser.tabs.create({ url: bookmark.url });
		},

		/** Delete a bookmark. */
		remove(id: BookmarkId) {
			workspaceClient.tables.bookmarks.delete(id);
		},

		/** Delete all bookmarks. Wrapped in a Y.Doc transaction. */
		removeAll() {
			const all = bookmarksMap.values().toArray();
			if (!all.length) return;

			workspaceClient.batch(() => {
				for (const bookmark of all) {
					workspaceClient.tables.bookmarks.delete(bookmark.id);
				}
			});
		},

		/** Update a bookmark's metadata in Y.Doc. */
		update(bookmark: Bookmark) {
			workspaceClient.tables.bookmarks.set(bookmark);
		},
	};
}

export const bookmarkState = createBookmarkState();
