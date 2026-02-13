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
 *   import { suspendedTabState } from '$lib/suspended-tab-state.svelte';
 * </script>
 *
 * {#each suspendedTabState.tabs as tab (tab.id)}
 *   <div>{tab.title}</div>
 * {/each}
 * ```
 */

import { getDeviceId } from '$lib/device-id';
import type { SuspendedTab, Tab } from '$lib/epicenter/browser.schema';
import {
	deleteSuspendedTab,
	restoreTab,
	suspendTab,
	updateSuspendedTab,
} from '$lib/epicenter/suspend-tab';
import { popupWorkspace } from '$lib/epicenter/workspace';

class SuspendedTabState {
	#tabs = $state<SuspendedTab[]>([]);

	constructor() {
		// Read immediately (may be empty if persistence hasn't loaded yet)
		this.#tabs = this.#readAll();

		// Re-read on every Y.Doc change — observer fires when persistence
		// loads and on any subsequent remote/local modification
		popupWorkspace.tables.suspendedTabs.observe(() => {
			this.#tabs = this.#readAll();
		});
	}

	/** All suspended tabs, sorted by most recently suspended first. */
	get tabs(): SuspendedTab[] {
		return this.#tabs;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Actions — write to Y.Doc + browser APIs
	// Y.Doc observer updates $state reactively.
	// ─────────────────────────────────────────────────────────────────────────

	readonly actions = {
		/** Suspend a tab — save to Y.Doc and close the browser tab. */
		async suspend(tab: Tab) {
			const deviceId = await getDeviceId();
			await suspendTab(popupWorkspace.tables, deviceId, tab);
		},

		/** Restore a suspended tab — open in browser and remove from Y.Doc. */
		async restore(suspendedTab: SuspendedTab) {
			await restoreTab(popupWorkspace.tables, suspendedTab);
		},

		/** Restore all suspended tabs. */
		async restoreAll() {
			const all = popupWorkspace.tables.suspendedTabs.getAllValid();
			for (const tab of all) {
				await restoreTab(popupWorkspace.tables, tab);
			}
		},

		/** Delete a suspended tab without restoring it. */
		remove(id: string) {
			deleteSuspendedTab(popupWorkspace.tables, id);
		},

		/** Delete all suspended tabs without restoring them. */
		removeAll() {
			const all = popupWorkspace.tables.suspendedTabs.getAllValid();
			for (const tab of all) {
				deleteSuspendedTab(popupWorkspace.tables, tab.id);
			}
		},

		/** Update a suspended tab's data. */
		update(suspendedTab: SuspendedTab) {
			updateSuspendedTab(popupWorkspace.tables, suspendedTab);
		},
	};

	// ─────────────────────────────────────────────────────────────────────────
	// Internal
	// ─────────────────────────────────────────────────────────────────────────

	#readAll(): SuspendedTab[] {
		return popupWorkspace.tables.suspendedTabs
			.getAllValid()
			.sort((a, b) => b.suspendedAt - a.suspendedAt);
	}
}

export const suspendedTabState = new SuspendedTabState();
