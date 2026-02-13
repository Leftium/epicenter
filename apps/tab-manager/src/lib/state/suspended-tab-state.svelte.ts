/**
 * Reactive suspended tab state for the popup.
 *
 * Reads from the Y.Doc `suspendedTabs` table via the popup workspace client.
 * Observes Y.Doc changes for reactive updates when background or remote
 * devices modify suspended tabs.
 *
 * Actions reuse existing suspend-tab.ts helpers.
 *
 * @example
 * ```svelte
 * <script>
 *   import { suspendedTabState } from '$lib/state/suspended-tab-state.svelte';
 * </script>
 *
 * {#each suspendedTabState.tabs as tab (tab.id)}
 *   <div>{tab.title}</div>
 * {/each}
 * ```
 */

import { generateId } from '@epicenter/hq/dynamic';
import { getDeviceId } from '$lib/device/device-id';
import type { SuspendedTab, Tab } from '$lib/schema';
import { popupWorkspace } from '$lib/workspace';

function createSuspendedTabState() {
	const readAll = () =>
		popupWorkspace.tables.suspendedTabs
			.getAllValid()
			.sort((a, b) => b.suspendedAt - a.suspendedAt);

	let tabs = $state<SuspendedTab[]>(readAll());

	// Re-read on every Y.Doc change — observer fires when persistence
	// loads and on any subsequent remote/local modification
	popupWorkspace.tables.suspendedTabs.observe(() => {
		tabs = readAll();
	});

	return {
		/** All suspended tabs, sorted by most recently suspended first. */
		get tabs() {
			return tabs;
		},

		actions: {
			/** Suspend a tab — save to Y.Doc and close the browser tab. */
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

			/** Restore a suspended tab — open in browser and remove from Y.Doc. */
			async restore(suspendedTab: SuspendedTab) {
				await browser.tabs.create({
					url: suspendedTab.url,
					pinned: suspendedTab.pinned,
				});
				popupWorkspace.tables.suspendedTabs.delete(suspendedTab.id);
			},

			/** Restore all suspended tabs. */
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

			/** Update a suspended tab's data. */
			update(suspendedTab: SuspendedTab) {
				popupWorkspace.tables.suspendedTabs.set(suspendedTab);
			},
		},
	};
}

export const suspendedTabState = createSuspendedTabState();
