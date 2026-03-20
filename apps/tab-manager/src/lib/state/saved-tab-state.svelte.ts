/**
 * Reactive saved tab state for the popup.
 *
 * Backed by a Y.Doc CRDT table, so saved tabs sync across devices and
 * survive browser restarts. Unlike {@link browserState} which seeds from the
 * browser API and tracks ephemeral browser state, saved tabs are
 * persistent user data — a tab saved on your laptop appears on your
 * desktop automatically.
 *
 * Backed by a `fromTable()` binding that provides granular per-row reactivity
 * via `SvelteMap`. The public API exposes a `$derived` sorted array since the
 * access pattern is always "render the full sorted list."
 *
 * Reactivity: The Y.Doc observer fires on persistence load AND on any
 * remote/local modification, so the UI stays in sync without polling.
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
import { getDeviceId } from '$lib/device/device-id';
import {
	generateSavedTabId,
	type SavedTab,
	type SavedTabId,
	workspace,
	} from '$lib/workspace';
import type { BrowserTab } from '$lib/state/browser-state.svelte';

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
		 * Save a tab — snapshot its metadata to Y.Doc and close the
		 * browser tab. The tab can be restored later on any synced device.
		 *
		 * Silently no-ops for tabs without a URL (e.g. `chrome://` pages
		 * that can't be re-opened via `browser.tabs.create`).
		 */
	async save(tab: BrowserTab) {
			if (!tab.url) return;
			const deviceId = await getDeviceId();
			workspace.tables.savedTabs.set({
				id: generateSavedTabId(),
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
				pinned: tab.pinned,
				sourceDeviceId: deviceId,
				savedAt: Date.now(),
				_v: 1,
			});
			await browser.tabs.remove(tab.id);
		},

		/**
		 * Restore a saved tab — re-open it in the browser and remove
		 * the record from Y.Doc. Preserves the tab's pinned state.
		 */
		async restore(savedTab: SavedTab) {
			await browser.tabs.create({
				url: savedTab.url,
				pinned: savedTab.pinned,
			});
			workspace.tables.savedTabs.delete(savedTab.id);
		},

		/**
		 * Restore all saved tabs at once.
		 *
		 * Fires all `browser.tabs.create()` calls in parallel (no sequential
		 * awaiting) and batch-deletes from Y.Doc in a single transaction.
		 *
		 * This avoids two problems with the naive sequential approach:
		 * 1. **Popup teardown**: `browser.tabs.create()` shifts focus, which
		 *    can cause Chrome to dispose the popup mid-loop — killing the
		 *    async context and leaving remaining tabs un-restored.
		 * 2. **Observer spam**: Each individual `delete()` fires the Y.Doc
		 *    observer, triggering a full `readAll()`. Wrapping in `transact()`
		 *    collapses N observer callbacks into one.
		 */
		async restoreAll() {
			const all = tabsMap.values().toArray();
			if (!all.length) return;

			// Fire all tab creations without awaiting each one individually.
			// browser.tabs.create() sends IPC to the browser process immediately —
			// the tabs will be created even if the popup is torn down afterward.
			const createPromises = all.map((tab) =>
				browser.tabs.create({ url: tab.url, pinned: tab.pinned }),
			);

			// Batch-delete from Y.Doc in a single transaction so the observer
			// fires exactly once (not N times).
			workspace.batch(() => {
				for (const tab of all) {
					workspace.tables.savedTabs.delete(tab.id);
				}
			});

			// Best-effort await — popup may die before this resolves, which is
			// fine because the browser process is already creating the tabs.
			await Promise.allSettled(createPromises);
		},

		/** Delete a saved tab without restoring it. */
		remove(id: SavedTabId) {
			workspace.tables.savedTabs.delete(id);
		},

		/**
		 * Delete all saved tabs without restoring them.
		 *
		 * Wrapped in a Y.Doc transaction so the observer fires once
		 * (not N times for N tabs).
		 */
		removeAll() {
			const all = tabsMap.values().toArray();
			if (!all.length) return;

			workspace.batch(() => {
				for (const tab of all) {
					workspace.tables.savedTabs.delete(tab.id);
				}
			});
		},

		/** Update a saved tab's metadata in Y.Doc. */
		update(savedTab: SavedTab) {
			workspace.tables.savedTabs.set(savedTab);
		},
	};
}

export const savedTabState = createSavedTabState();
