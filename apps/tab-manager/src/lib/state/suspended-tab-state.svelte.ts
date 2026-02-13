/**
 * Reactive suspended tab state for the popup.
 *
 * Backed by a Y.Doc CRDT table, so suspended tabs sync across devices and
 * survive browser restarts. Unlike {@link browserState} which seeds from the
 * browser API and tracks ephemeral browser state, suspended tabs are
 * persistent user data — a tab suspended on your laptop appears on your
 * desktop automatically.
 *
 * Uses a plain `$state` array (not `SvelteMap`) because the access pattern is
 * always "render the full sorted list." There's no keyed lookup, no partial
 * mutation — the Y.Doc observer wholesale-replaces the array on every change,
 * which is the simplest reactive model for a list that's always read in full.
 *
 * Reactivity: The Y.Doc observer fires on persistence load AND on any
 * remote/local modification, so the UI stays in sync without polling.
 *
 * @example
 * ```svelte
 * <script>
 *   import { suspendedTabState } from '$lib/state/suspended-tab-state.svelte';
 * </script>
 *
 * {#each suspendedTabState.tabs as tab (tab.id)}
 *   <SuspendedTabItem {tab} />
 * {/each}
 *
 * <button onclick={() => suspendedTabState.actions.restoreAll()}>
 *   Restore all
 * </button>
 * ```
 */

import { generateId } from '@epicenter/hq/dynamic';
import { getDeviceId } from '$lib/device/device-id';
import type { SuspendedTab, Tab } from '$lib/workspace';
import { popupWorkspace } from '$lib/workspace-popup';

function createSuspendedTabState() {
	/** Read all valid suspended tabs, most recently suspended first. */
	const readAll = () =>
		popupWorkspace.tables.suspendedTabs
			.getAllValid()
			.sort((a, b) => b.suspendedAt - a.suspendedAt);

	/**
	 * The full sorted list of suspended tabs.
	 *
	 * Wholesale-replaced on every Y.Doc change rather than surgically mutated.
	 * This is intentional — the Y.Doc observer doesn't tell us *what* changed,
	 * only *that* something changed, so a full re-read is the simplest correct
	 * approach. The list is small enough that this is never a perf concern.
	 */
	let tabs = $state<SuspendedTab[]>(readAll());

	// Re-read on every Y.Doc change — observer fires when persistence
	// loads and on any subsequent remote/local modification.
	popupWorkspace.tables.suspendedTabs.observe(() => {
		tabs = readAll();
	});

	return {
		/** All suspended tabs, sorted by most recently suspended first. */
		get tabs() {
			return tabs;
		},

		/**
		 * Actions that mutate suspended tab state.
		 *
		 * All mutations go through the Y.Doc table, which fires the observer,
		 * which re-reads the full list into `tabs`. This keeps the mutation path
		 * unidirectional — components call actions, actions write to Y.Doc,
		 * Y.Doc observer updates the reactive array. No direct `tabs` mutation
		 * outside the observer.
		 */
		actions: {
			/**
			 * Suspend a tab — snapshot its metadata to Y.Doc and close the
			 * browser tab. The tab can be restored later on any synced device.
			 *
			 * Silently no-ops for tabs without a URL (e.g. `chrome://` pages
			 * that can't be re-opened via `browser.tabs.create`).
			 */
			async suspend(tab: Tab) {
				if (!tab.url) return;
				const deviceId = await getDeviceId();
				popupWorkspace.tables.suspendedTabs.set({
					id: generateId(),
					url: tab.url,
					title: tab.title || 'Untitled',
					favIconUrl: tab.favIconUrl,
					pinned: tab.pinned,
					sourceDeviceId: deviceId,
					suspendedAt: Date.now(),
				});
				await browser.tabs.remove(tab.tabId);
			},

			/**
			 * Restore a suspended tab — re-open it in the browser and remove
			 * the record from Y.Doc. Preserves the tab's pinned state.
			 */
			async restore(suspendedTab: SuspendedTab) {
				await browser.tabs.create({
					url: suspendedTab.url,
					pinned: suspendedTab.pinned,
				});
				popupWorkspace.tables.suspendedTabs.delete(suspendedTab.id);
			},

			/**
			 * Restore all suspended tabs at once. Opens each tab sequentially
			 * to avoid overwhelming the browser, then removes each from Y.Doc.
			 */
			async restoreAll() {
				const all = popupWorkspace.tables.suspendedTabs.getAllValid();
				for (const tab of all) {
					await browser.tabs.create({
						url: tab.url,
						pinned: tab.pinned,
					});
					popupWorkspace.tables.suspendedTabs.delete(tab.id);
				}
			},

			/** Delete a suspended tab without restoring it. */
			remove(id: string) {
				popupWorkspace.tables.suspendedTabs.delete(id);
			},

			/** Delete all suspended tabs without restoring them. */
			removeAll() {
				const all = popupWorkspace.tables.suspendedTabs.getAllValid();
				for (const tab of all) {
					popupWorkspace.tables.suspendedTabs.delete(tab.id);
				}
			},

			/** Update a suspended tab's metadata in Y.Doc. */
			update(suspendedTab: SuspendedTab) {
				popupWorkspace.tables.suspendedTabs.set(suspendedTab);
			},
		},
	};
}

export const suspendedTabState = createSuspendedTabState();
