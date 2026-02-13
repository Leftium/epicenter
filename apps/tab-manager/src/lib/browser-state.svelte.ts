/**
 * Reactive browser state for the popup.
 *
 * Seeds from `browser.windows.getAll({ populate: true })` and receives
 * surgical updates via browser event listeners. Replaces TanStack Query
 * for live tab/window data.
 *
 * Lifecycle: Created when popup opens. All listeners die when popup closes.
 * Next open → fresh seed + fresh listeners. No cleanup needed.
 *
 * @example
 * ```svelte
 * <script>
 *   import { browserState } from '$lib/browser-state.svelte';
 * </script>
 *
 * {#each browserState.windows as window (window.id)}
 *   {#each browserState.tabsByWindow(window.id) as tab (tab.id)}
 *     <TabItem {tab} />
 *   {/each}
 * {/each}
 * ```
 */

import { SvelteMap } from 'svelte/reactivity';
import { getDeviceId } from '$lib/device-id';
import {
	createWindowCompositeId,
	type Tab,
	tabToRow,
	type Window,
	type WindowCompositeId,
	windowToRow,
} from '$lib/epicenter/browser.schema';

function createBrowserState() {
	const tabs = new SvelteMap<number, Tab>();
	let windows = $state<Window[]>([]);
	let ready = $state(false);
	let deviceId: string | null = null;

	// ── Seed — single IPC call gets windows + tabs ────────────────────────

	(async () => {
		deviceId = await getDeviceId();
		const browserWindows = await browser.windows.getAll({ populate: true });

		const seedWindows: Window[] = [];

		for (const win of browserWindows) {
			const windowRow = windowToRow(deviceId, win);
			if (windowRow) seedWindows.push(windowRow);

			if (win.tabs) {
				for (const tab of win.tabs) {
					const tabRow = tabToRow(deviceId, tab);
					if (tabRow) tabs.set(tabRow.tabId, tabRow);
				}
			}
		}

		windows = seedWindows;
		ready = true;
	})();

	// ── Tab Event Listeners ───────────────────────────────────────────────

	// onCreated: Full Tab object provided
	browser.tabs.onCreated.addListener((tab) => {
		if (!ready) return;
		const row = tabToRow(deviceId!, tab);
		if (!row) return;
		tabs.set(row.tabId, row);
	});

	// onRemoved: Only tabId provided — delete from map
	browser.tabs.onRemoved.addListener((tabId) => {
		if (!ready) return;
		tabs.delete(tabId);
	});

	// onUpdated: Full Tab in 3rd arg — update in map
	browser.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
		if (!ready) return;
		const row = tabToRow(deviceId!, tab);
		if (!row) return;
		tabs.set(row.tabId, row);
	});

	// onMoved: Re-query tab to get updated index
	browser.tabs.onMoved.addListener(async (tabId) => {
		if (!ready) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const row = tabToRow(deviceId!, tab);
			if (!row) return;
			tabs.set(row.tabId, row);
		} catch {
			// Tab may have been closed during move
		}
	});

	// onActivated: Update active flags on old and new tab
	browser.tabs.onActivated.addListener((activeInfo) => {
		if (!ready) return;
		const windowId = createWindowCompositeId(deviceId!, activeInfo.windowId);

		// Deactivate previous active tab(s) in this window
		for (const [tabId, tab] of tabs) {
			if (tab.windowId === windowId && tab.active) {
				tabs.set(tabId, { ...tab, active: false });
			}
		}

		// Activate the new tab
		const tab = tabs.get(activeInfo.tabId);
		if (tab) {
			tabs.set(activeInfo.tabId, { ...tab, active: true });
		}
	});

	// onAttached: Tab moved between windows — re-query
	browser.tabs.onAttached.addListener(async (tabId) => {
		if (!ready) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const row = tabToRow(deviceId!, tab);
			if (!row) return;
			tabs.set(row.tabId, row);
		} catch {
			// Tab may have been closed
		}
	});

	// onDetached: Tab detached from window — re-query
	browser.tabs.onDetached.addListener(async (tabId) => {
		if (!ready) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const row = tabToRow(deviceId!, tab);
			if (!row) return;
			tabs.set(row.tabId, row);
		} catch {
			// Tab may have been closed during detach
		}
	});

	// ── Window Event Listeners ────────────────────────────────────────────

	// onCreated: Full Window object provided
	browser.windows.onCreated.addListener((window) => {
		if (!ready) return;
		const row = windowToRow(deviceId!, window);
		if (!row) return;
		windows.push(row);
	});

	// onRemoved: Remove window and all its tabs
	browser.windows.onRemoved.addListener((windowId) => {
		if (!ready) return;
		const compositeId = createWindowCompositeId(deviceId!, windowId);

		// Remove window
		const winIdx = windows.findIndex((w) => w.id === compositeId);
		if (winIdx !== -1) {
			windows.splice(winIdx, 1);
		}

		// Remove all tabs in that window
		for (const [tabId, tab] of tabs) {
			if (tab.windowId === compositeId) {
				tabs.delete(tabId);
			}
		}
	});

	// onFocusChanged: Update focused flags
	browser.windows.onFocusChanged.addListener((windowId) => {
		if (!ready) return;

		// Unfocus all windows
		for (let i = 0; i < windows.length; i++) {
			if (windows[i].focused) {
				windows[i] = { ...windows[i], focused: false };
			}
		}

		// Focus the new window (WINDOW_ID_NONE means all lost focus)
		if (windowId !== browser.windows.WINDOW_ID_NONE) {
			const compositeId = createWindowCompositeId(deviceId!, windowId);
			const winIdx = windows.findIndex((w) => w.id === compositeId);
			if (winIdx !== -1) {
				windows[winIdx] = { ...windows[winIdx], focused: true };
			}
		}
	});

	return {
		/** Whether the initial seed has completed. */
		get seeded() {
			return ready;
		},

		/** All tabs across all windows. */
		get tabs() {
			return [...tabs.values()];
		},

		/** All browser windows. */
		get windows() {
			return windows;
		},

		/**
		 * Get tabs for a specific window, sorted by tab strip index.
		 *
		 * @example
		 * ```svelte
		 * {#each browserState.tabsByWindow(window.id) as tab (tab.id)}
		 *   <TabItem {tab} />
		 * {/each}
		 * ```
		 */
		tabsByWindow(windowId: WindowCompositeId): Tab[] {
			return [...tabs.values()]
				.filter((t) => t.windowId === windowId)
				.sort((a, b) => a.index - b.index);
		},

		actions: {
			/** Close a tab. Browser onRemoved event updates state. */
			async close(tabId: number) {
				await browser.tabs.remove(tabId);
			},

			/** Activate a tab and focus its window. */
			async activate(tabId: number) {
				const tab = await browser.tabs.update(tabId, { active: true });
				if (tab?.windowId) {
					await browser.windows.update(tab.windowId, { focused: true });
				}
			},

			/** Pin a tab. */
			async pin(tabId: number) {
				await browser.tabs.update(tabId, { pinned: true });
			},

			/** Unpin a tab. */
			async unpin(tabId: number) {
				await browser.tabs.update(tabId, { pinned: false });
			},

			/** Mute a tab. */
			async mute(tabId: number) {
				await browser.tabs.update(tabId, { muted: true });
			},

			/** Unmute a tab. */
			async unmute(tabId: number) {
				await browser.tabs.update(tabId, { muted: false });
			},

			/** Reload a tab. */
			async reload(tabId: number) {
				await browser.tabs.reload(tabId);
			},

			/** Duplicate a tab. */
			async duplicate(tabId: number) {
				await browser.tabs.duplicate(tabId);
			},
		},
	};
}

export const browserState = createBrowserState();
