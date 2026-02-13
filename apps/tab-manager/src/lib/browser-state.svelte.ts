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
	let tabs = $state<Tab[]>([]);
	let windows = $state<Window[]>([]);
	let ready = $state(false);
	/** nativeTabId → index in tabs. Rebuilt on structural changes (add/remove). */
	const tabIndex = new Map<number, number>();
	let deviceId: string | null = null;

	function rebuildIndex() {
		tabIndex.clear();
		for (let i = 0; i < tabs.length; i++) {
			tabIndex.set(tabs[i].tabId, i);
		}
	}

	async function resolveDeviceId(): Promise<string> {
		if (deviceId) return deviceId;
		deviceId = await getDeviceId();
		return deviceId;
	}

	// ── Seed — single IPC call gets windows + tabs ────────────────────────

	async function seed() {
		deviceId = await getDeviceId();
		const browserWindows = await browser.windows.getAll({ populate: true });

		const seedWindows: Window[] = [];
		const seedTabs: Tab[] = [];

		for (const win of browserWindows) {
			const windowRow = windowToRow(deviceId, win);
			if (windowRow) seedWindows.push(windowRow);

			if (win.tabs) {
				for (const tab of win.tabs) {
					const tabRow = tabToRow(deviceId, tab);
					if (tabRow) seedTabs.push(tabRow);
				}
			}
		}

		seedTabs.sort((a, b) => a.index - b.index);

		windows = seedWindows;
		tabs = seedTabs;
		rebuildIndex();
		ready = true;
	}

	// ── Browser Event Listeners — surgical $state mutations ───────────────

	function registerListeners() {
		// ── Tab Events ────────────────────────────────────────────────────

		// onCreated: Full Tab object provided
		browser.tabs.onCreated.addListener(async (tab) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			const row = tabToRow(id, tab);
			if (!row) return;
			tabs.push(row);
			tabIndex.set(row.tabId, tabs.length - 1);
		});

		// onRemoved: Only tabId provided — splice from array
		browser.tabs.onRemoved.addListener(async (tabId) => {
			if (!ready) return;
			const idx = tabIndex.get(tabId);
			if (idx === undefined) return;
			tabs.splice(idx, 1);
			rebuildIndex();
		});

		// onUpdated: Full Tab in 3rd arg — replace element at index
		browser.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			const row = tabToRow(id, tab);
			if (!row) return;
			const idx = tabIndex.get(row.tabId);
			if (idx !== undefined) {
				tabs[idx] = row;
			}
		});

		// onMoved: Re-query tab to get updated index
		browser.tabs.onMoved.addListener(async (tabId) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			try {
				const tab = await browser.tabs.get(tabId);
				const row = tabToRow(id, tab);
				if (!row) return;
				const idx = tabIndex.get(row.tabId);
				if (idx !== undefined) {
					tabs[idx] = row;
				}
			} catch {
				// Tab may have been closed during move
			}
		});

		// onActivated: Update active flags on old and new tab
		browser.tabs.onActivated.addListener(async (activeInfo) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			const windowId = createWindowCompositeId(id, activeInfo.windowId);

			// Deactivate previous active tab(s) in this window
			for (let i = 0; i < tabs.length; i++) {
				if (tabs[i].windowId === windowId && tabs[i].active) {
					tabs[i] = { ...tabs[i], active: false };
				}
			}

			// Activate the new tab
			const idx = tabIndex.get(activeInfo.tabId);
			if (idx !== undefined) {
				tabs[idx] = { ...tabs[idx], active: true };
			}
		});

		// onAttached: Tab moved between windows — re-query
		browser.tabs.onAttached.addListener(async (tabId) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			try {
				const tab = await browser.tabs.get(tabId);
				const row = tabToRow(id, tab);
				if (!row) return;
				const idx = tabIndex.get(row.tabId);
				if (idx !== undefined) {
					tabs[idx] = row;
				} else {
					tabs.push(row);
					tabIndex.set(row.tabId, tabs.length - 1);
				}
			} catch {
				// Tab may have been closed
			}
		});

		// onDetached: Tab detached from window — re-query
		browser.tabs.onDetached.addListener(async (tabId) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			try {
				const tab = await browser.tabs.get(tabId);
				const row = tabToRow(id, tab);
				if (!row) return;
				const idx = tabIndex.get(row.tabId);
				if (idx !== undefined) {
					tabs[idx] = row;
				}
			} catch {
				// Tab may have been closed during detach
			}
		});

		// ── Window Events ─────────────────────────────────────────────────

		// onCreated: Full Window object provided
		browser.windows.onCreated.addListener(async (window) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			const row = windowToRow(id, window);
			if (!row) return;
			windows.push(row);
		});

		// onRemoved: Remove window and all its tabs
		browser.windows.onRemoved.addListener(async (windowId) => {
			if (!ready) return;
			const id = await resolveDeviceId();
			const compositeId = createWindowCompositeId(id, windowId);

			// Remove window
			const winIdx = windows.findIndex((w) => w.id === compositeId);
			if (winIdx !== -1) {
				windows.splice(winIdx, 1);
			}

			// Remove all tabs in that window
			tabs = tabs.filter((t) => t.windowId !== compositeId);
			rebuildIndex();
		});

		// onFocusChanged: Update focused flags
		browser.windows.onFocusChanged.addListener(async (windowId) => {
			if (!ready) return;
			const id = await resolveDeviceId();

			// Unfocus all windows
			for (let i = 0; i < windows.length; i++) {
				if (windows[i].focused) {
					windows[i] = { ...windows[i], focused: false };
				}
			}

			// Focus the new window (WINDOW_ID_NONE means all lost focus)
			if (windowId !== browser.windows.WINDOW_ID_NONE) {
				const compositeId = createWindowCompositeId(id, windowId);
				const winIdx = windows.findIndex((w) => w.id === compositeId);
				if (winIdx !== -1) {
					windows[winIdx] = { ...windows[winIdx], focused: true };
				}
			}
		});
	}

	seed();
	registerListeners();

	return {
		/** Whether the initial seed has completed. */
		get seeded() {
			return ready;
		},

		/** All tabs across all windows. */
		get tabs() {
			return tabs;
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
			return tabs
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
