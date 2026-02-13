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

class BrowserState {
	#tabs = $state<Tab[]>([]);
	#windows = $state<Window[]>([]);
	#ready = $state(false);
	/** nativeTabId → index in #tabs. Rebuilt on structural changes (add/remove). */
	#tabIndex = new Map<number, number>();
	#deviceId: string | null = null;

	constructor() {
		this.#seed();
		this.#registerListeners();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Public Getters
	// ─────────────────────────────────────────────────────────────────────────

	/** Whether the initial seed has completed. */
	get seeded(): boolean {
		return this.#ready;
	}

	/** All tabs across all windows. */
	get tabs(): Tab[] {
		return this.#tabs;
	}

	/** All browser windows. */
	get windows(): Window[] {
		return this.#windows;
	}

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
		return this.#tabs
			.filter((t) => t.windowId === windowId)
			.sort((a, b) => a.index - b.index);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Actions — direct browser API calls
	// Browser events update $state reactively. No mutation wrappers needed.
	// ─────────────────────────────────────────────────────────────────────────

	readonly actions = {
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
	};

	// ─────────────────────────────────────────────────────────────────────────
	// Seed — single IPC call gets windows + tabs
	// ─────────────────────────────────────────────────────────────────────────

	async #seed() {
		this.#deviceId = await getDeviceId();
		const browserWindows = await browser.windows.getAll({ populate: true });

		const windows: Window[] = [];
		const tabs: Tab[] = [];

		for (const win of browserWindows) {
			const windowRow = windowToRow(this.#deviceId, win);
			if (windowRow) windows.push(windowRow);

			if (win.tabs) {
				for (const tab of win.tabs) {
					const tabRow = tabToRow(this.#deviceId, tab);
					if (tabRow) tabs.push(tabRow);
				}
			}
		}

		tabs.sort((a, b) => a.index - b.index);

		this.#windows = windows;
		this.#tabs = tabs;
		this.#rebuildIndex();
		this.#ready = true;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Index Management
	// ─────────────────────────────────────────────────────────────────────────

	#rebuildIndex() {
		this.#tabIndex.clear();
		for (let i = 0; i < this.#tabs.length; i++) {
			this.#tabIndex.set(this.#tabs[i].tabId, i);
		}
	}

	async #getDeviceId(): Promise<string> {
		if (this.#deviceId) return this.#deviceId;
		this.#deviceId = await getDeviceId();
		return this.#deviceId;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Browser Event Listeners — surgical $state mutations
	// ─────────────────────────────────────────────────────────────────────────

	#registerListeners() {
		// ── Tab Events ───────────────────────────────────────────────────────

		// onCreated: Full Tab object provided
		browser.tabs.onCreated.addListener(async (tab) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			const row = tabToRow(deviceId, tab);
			if (!row) return;
			this.#tabs.push(row);
			this.#tabIndex.set(row.tabId, this.#tabs.length - 1);
		});

		// onRemoved: Only tabId provided — splice from array
		browser.tabs.onRemoved.addListener(async (tabId) => {
			if (!this.#ready) return;
			const idx = this.#tabIndex.get(tabId);
			if (idx === undefined) return;
			this.#tabs.splice(idx, 1);
			this.#rebuildIndex();
		});

		// onUpdated: Full Tab in 3rd arg — replace element at index
		browser.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			const row = tabToRow(deviceId, tab);
			if (!row) return;
			const idx = this.#tabIndex.get(row.tabId);
			if (idx !== undefined) {
				this.#tabs[idx] = row;
			}
		});

		// onMoved: Re-query tab to get updated index
		browser.tabs.onMoved.addListener(async (tabId) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			try {
				const tab = await browser.tabs.get(tabId);
				const row = tabToRow(deviceId, tab);
				if (!row) return;
				const idx = this.#tabIndex.get(row.tabId);
				if (idx !== undefined) {
					this.#tabs[idx] = row;
				}
			} catch {
				// Tab may have been closed during move
			}
		});

		// onActivated: Update active flags on old and new tab
		browser.tabs.onActivated.addListener(async (activeInfo) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			const windowId = createWindowCompositeId(deviceId, activeInfo.windowId);

			// Deactivate previous active tab(s) in this window
			for (let i = 0; i < this.#tabs.length; i++) {
				if (this.#tabs[i].windowId === windowId && this.#tabs[i].active) {
					this.#tabs[i] = { ...this.#tabs[i], active: false };
				}
			}

			// Activate the new tab
			const idx = this.#tabIndex.get(activeInfo.tabId);
			if (idx !== undefined) {
				this.#tabs[idx] = { ...this.#tabs[idx], active: true };
			}
		});

		// onAttached: Tab moved between windows — re-query
		browser.tabs.onAttached.addListener(async (tabId) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			try {
				const tab = await browser.tabs.get(tabId);
				const row = tabToRow(deviceId, tab);
				if (!row) return;
				const idx = this.#tabIndex.get(row.tabId);
				if (idx !== undefined) {
					this.#tabs[idx] = row;
				} else {
					this.#tabs.push(row);
					this.#tabIndex.set(row.tabId, this.#tabs.length - 1);
				}
			} catch {
				// Tab may have been closed
			}
		});

		// onDetached: Tab detached from window — re-query
		browser.tabs.onDetached.addListener(async (tabId) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			try {
				const tab = await browser.tabs.get(tabId);
				const row = tabToRow(deviceId, tab);
				if (!row) return;
				const idx = this.#tabIndex.get(row.tabId);
				if (idx !== undefined) {
					this.#tabs[idx] = row;
				}
			} catch {
				// Tab may have been closed during detach
			}
		});

		// ── Window Events ────────────────────────────────────────────────────

		// onCreated: Full Window object provided
		browser.windows.onCreated.addListener(async (window) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			const row = windowToRow(deviceId, window);
			if (!row) return;
			this.#windows.push(row);
		});

		// onRemoved: Remove window and all its tabs
		browser.windows.onRemoved.addListener(async (windowId) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();
			const compositeId = createWindowCompositeId(deviceId, windowId);

			// Remove window
			const winIdx = this.#windows.findIndex((w) => w.id === compositeId);
			if (winIdx !== -1) {
				this.#windows.splice(winIdx, 1);
			}

			// Remove all tabs in that window
			this.#tabs = this.#tabs.filter((t) => t.windowId !== compositeId);
			this.#rebuildIndex();
		});

		// onFocusChanged: Update focused flags
		browser.windows.onFocusChanged.addListener(async (windowId) => {
			if (!this.#ready) return;
			const deviceId = await this.#getDeviceId();

			// Unfocus all windows
			for (let i = 0; i < this.#windows.length; i++) {
				if (this.#windows[i].focused) {
					this.#windows[i] = {
						...this.#windows[i],
						focused: false,
					};
				}
			}

			// Focus the new window (WINDOW_ID_NONE means all lost focus)
			if (windowId !== browser.windows.WINDOW_ID_NONE) {
				const compositeId = createWindowCompositeId(deviceId, windowId);
				const winIdx = this.#windows.findIndex((w) => w.id === compositeId);
				if (winIdx !== -1) {
					this.#windows[winIdx] = {
						...this.#windows[winIdx],
						focused: true,
					};
				}
			}
		});
	}
}

export const browserState = new BrowserState();
