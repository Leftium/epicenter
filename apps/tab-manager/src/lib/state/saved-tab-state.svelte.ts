/**
 * Reactive saved tab state for the side panel.
 *
 * Read-only reactive layer backed by `fromTable()` — provides granular
 * per-row reactivity via `SvelteMap`. All write operations are delegated
 * to workspace actions defined in `client.ts`.
 *
 * The public API exposes a `$derived` sorted array since the access
 * pattern is always "render the full sorted list."
 *
 * @example
 * ```svelte
 * <script>
 *   import { savedTabState } from '$lib/state/saved-tab-state.svelte';
 * </script>
 *
 * {#each savedTabState.tabs as tab (tab.id)}
 *   <SavedTabItem {tab} />
 * {/each}
 *
 * <button onclick={() => savedTabState.restoreAll()}>
 *   Restore all
 * </button>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { SavedTab, SavedTabId } from '$lib/workspace';

function createSavedTabState() {
	const tabsMap = fromTable(workspace.tables.savedTabs);

	/** All saved tabs, sorted by most recently saved first. Cached via $derived. */
	const tabs = $derived(
		tabsMap
			.values()
			.toArray()
			.sort((a, b) => b.savedAt - a.savedAt),
	);

	return {
		get tabs() {
			return tabs;
		},

		/**
		 * Save a tab — snapshot its metadata to Y.Doc and close the browser tab.
		 *
		 * Delegates to the `savedTabs.save` workspace action so the operation
		 * is AI-callable and follows the same code path as programmatic saves.
		 * Silently no-ops for tabs without a URL.
		 */
		async save(tab: BrowserTab) {
			if (!tab.url) return;
			await workspace.actions.savedTabs.save({
				browserTabId: tab.id,
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
				pinned: tab.pinned,
			});
		},

		/**
		 * Restore a saved tab — re-open in browser and delete the record.
		 *
		 * Delegates to the `savedTabs.restore` workspace action.
		 */
		async restore(savedTab: SavedTab) {
			await workspace.actions.savedTabs.restore({
				id: savedTab.id,
				url: savedTab.url,
				pinned: savedTab.pinned,
			});
		},

		/**
		 * Restore all saved tabs at once.
		 *
		 * Delegates to the `savedTabs.restoreAll` workspace action which
		 * fires all tab creations in parallel and batch-deletes from Y.Doc.
		 */
		async restoreAll() {
			await workspace.actions.savedTabs.restoreAll({});
		},

		/**
		 * Delete a saved tab without restoring it.
		 *
		 * Delegates to the `savedTabs.remove` workspace action.
		 */
		async remove(id: SavedTabId) {
			await workspace.actions.savedTabs.remove({ id });
		},

		/**
		 * Delete all saved tabs without restoring them.
		 *
		 * Delegates to the `savedTabs.removeAll` workspace action.
		 */
		async removeAll() {
			await workspace.actions.savedTabs.removeAll({});
		},
	};
}

export const savedTabState = createSavedTabState();
