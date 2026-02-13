/**
 * Reactive browser state for the popup.
 *
 * Seeds from `browser.windows.getAll({ populate: true })` and receives
 * surgical updates via browser event listeners. Uses a single coupled
 * `SvelteMap<WindowCompositeId, WindowState>` where each window owns its tabs.
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

type WindowState = {
	window: Window;
	tabs: SvelteMap<number, Tab>;
};

function createBrowserState() {
	const windowStates = new SvelteMap<WindowCompositeId, WindowState>();
	let deviceId: string | null = null;

	// ── Seed — single IPC call gets windows + tabs ────────────────────────

	(async () => {
		const browserWindows = await browser.windows.getAll({ populate: true });
		const id = await getDeviceId();

		for (const win of browserWindows) {
			const windowRow = windowToRow(id, win);
			if (!windowRow) continue;

			const tabsMap = new SvelteMap<number, Tab>();
			if (win.tabs) {
				for (const tab of win.tabs) {
					const tabRow = tabToRow(id, tab);
					if (tabRow) tabsMap.set(tabRow.tabId, tabRow);
				}
			}

			windowStates.set(windowRow.id, { window: windowRow, tabs: tabsMap });
		}

		// Set deviceId LAST — it's the readiness signal for event handlers
		deviceId = id;
	})();

	// ── Tab Event Listeners ───────────────────────────────────────────────

	// onCreated: Full Tab object provided
	browser.tabs.onCreated.addListener((tab) => {
		if (!deviceId) return;
		const row = tabToRow(deviceId, tab);
		if (!row) return;
		const state = windowStates.get(row.windowId);
		if (!state) return;
		state.tabs.set(row.tabId, row);
	});

	// onRemoved: tabId + removeInfo with windowId
	browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
		if (!deviceId) return;
		if (removeInfo.isWindowClosing) return;
		const compositeId = createWindowCompositeId(deviceId, removeInfo.windowId);
		windowStates.get(compositeId)?.tabs.delete(tabId);
	});

	// onUpdated: Full Tab in 3rd arg — route to correct window
	browser.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
		if (!deviceId) return;
		const row = tabToRow(deviceId, tab);
		if (!row) return;
		const state = windowStates.get(row.windowId);
		if (!state) return;
		state.tabs.set(row.tabId, row);
	});

	// onMoved: Re-query tab to get updated index
	browser.tabs.onMoved.addListener(async (tabId) => {
		if (!deviceId) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const row = tabToRow(deviceId, tab);
			if (!row) return;
			const state = windowStates.get(row.windowId);
			if (!state) return;
			state.tabs.set(row.tabId, row);
		} catch {
			// Tab may have been closed during move
		}
	});

	// onActivated: Update active flags — scoped to one window
	browser.tabs.onActivated.addListener((activeInfo) => {
		if (!deviceId) return;
		const compositeId = createWindowCompositeId(deviceId, activeInfo.windowId);
		const state = windowStates.get(compositeId);
		if (!state) return;

		// Deactivate previous active tab(s) in this window only
		for (const [tabId, tab] of state.tabs) {
			if (tab.active) {
				state.tabs.set(tabId, { ...tab, active: false });
			}
		}

		// Activate the new tab
		const tab = state.tabs.get(activeInfo.tabId);
		if (tab) {
			state.tabs.set(activeInfo.tabId, { ...tab, active: true });
		}
	});

	// onAttached: Tab moved to a new window — add to new window's map
	browser.tabs.onAttached.addListener(async (tabId) => {
		if (!deviceId) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const row = tabToRow(deviceId, tab);
			if (!row) return;
			const state = windowStates.get(row.windowId);
			if (!state) return;
			state.tabs.set(row.tabId, row);
		} catch {
			// Tab may have been closed
		}
	});

	// onDetached: Tab leaving a window — remove from old window's map
	browser.tabs.onDetached.addListener((tabId, detachInfo) => {
		if (!deviceId) return;
		const compositeId = createWindowCompositeId(
			deviceId,
			detachInfo.oldWindowId,
		);
		windowStates.get(compositeId)?.tabs.delete(tabId);
	});

	// ── Window Event Listeners ────────────────────────────────────────────

	// onCreated: Full Window object provided
	browser.windows.onCreated.addListener((window) => {
		if (!deviceId) return;
		const row = windowToRow(deviceId, window);
		if (!row) return;
		windowStates.set(row.id, { window: row, tabs: new SvelteMap() });
	});

	// onRemoved: Delete window entry — its tabs vanish with it
	browser.windows.onRemoved.addListener((windowId) => {
		if (!deviceId) return;
		const compositeId = createWindowCompositeId(deviceId, windowId);
		windowStates.delete(compositeId);
	});

	// onFocusChanged: Update focused flags
	browser.windows.onFocusChanged.addListener((windowId) => {
		if (!deviceId) return;

		// Unfocus all windows
		for (const [id, state] of windowStates) {
			if (state.window.focused) {
				windowStates.set(id, {
					...state,
					window: { ...state.window, focused: false },
				});
			}
		}

		// Focus the new window (WINDOW_ID_NONE means all lost focus)
		if (windowId !== browser.windows.WINDOW_ID_NONE) {
			const compositeId = createWindowCompositeId(deviceId, windowId);
			const state = windowStates.get(compositeId);
			if (state) {
				windowStates.set(compositeId, {
					...state,
					window: { ...state.window, focused: true },
				});
			}
		}
	});

	return {
		/** All browser windows. */
		get windows() {
			return [...windowStates.values()].map((s) => s.window);
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
			const state = windowStates.get(windowId);
			if (!state) return [];
			return [...state.tabs.values()].sort((a, b) => a.index - b.index);
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
