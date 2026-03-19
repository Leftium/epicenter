/**
 * Reactive browser state for the side panel.
 *
 * Seeds from `browser.windows.getAll({ populate: true })` and receives
 * surgical updates via browser event listeners. Chrome is the sole authority
 * for live tab/window state—no Y.Doc, no CRDT, no cross-device sync for
 * ephemeral browser data.
 *
 * Uses a single `SvelteMap<number, WindowState>` keyed by Chrome's native
 * `windowId`. Each window owns its tabs in an inner SvelteMap for per-window
 * reactive granularity.
 *
 * Lifecycle: Created when side panel opens. All listeners die when panel closes.
 * Next open → fresh seed + fresh listeners. No cleanup needed.
 *
 * @example
 * ```svelte
 * <script>
 *   import { browserState } from '$lib/state/browser-state.svelte';
 * </script>
 *
 * {#each browserState.windows as window (window.windowId)}
 *   {#each browserState.tabsByWindow(window.windowId) as tab (tab.tabId)}
 *     <TabItem {tab} />
 *   {/each}
 * {/each}
 * ```
 */

import { SvelteMap } from 'svelte/reactivity';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Chrome assigns -1 to tabs that aren't real browser tabs (e.g. devtools). */
const TAB_ID_NONE = -1;

/**
 * Convert a Chrome window to a plain object the UI can render.
 *
 * Returns `null` if the window has no ID (e.g. sessions API).
 * The return shape IS the `BrowserWindow` type—derived via `ReturnType`
 * so the converter is the single source of truth.
 */
function toBrowserWindow(win: Browser.windows.Window) {
	if (win.id === undefined) return null;
	return {
		windowId: win.id,
		focused: win.focused,
	};
}

/**
 * Convert a Chrome tab to a plain object the UI can render.
 *
 * Returns `null` if the tab has no usable ID—either `undefined`
 * (foreign tabs from the sessions API) or `-1` (`TAB_ID_NONE`).
 * The return shape IS the `BrowserTab` type—derived via `ReturnType`
 * so the converter is the single source of truth.
 */
function toBrowserTab(tab: Browser.tabs.Tab) {
	if (tab.id === undefined || tab.id === TAB_ID_NONE) return null;
	return {
		tabId: tab.id,
		windowId: tab.windowId,
		index: tab.index,
		title: tab.title ?? '',
		url: tab.url ?? '',
		favIconUrl: tab.favIconUrl ?? '',
		active: tab.active,
		pinned: tab.pinned,
		audible: tab.audible ?? false,
		mutedInfo: { muted: tab.mutedInfo?.muted ?? false },
	};
}

/** Plain browser window—derived from {@link toBrowserWindow}'s return shape. */
export type BrowserWindow = NonNullable<ReturnType<typeof toBrowserWindow>>;

/** Plain browser tab—derived from {@link toBrowserTab}'s return shape. */
export type BrowserTab = NonNullable<ReturnType<typeof toBrowserTab>>;

/**
 * A window and all the tabs it owns, stored together.
 *
 * Browser state is inherently hierarchical—tabs belong to windows. Storing
 * them as a coupled unit means every access pattern (render a window's tabs,
 * remove a window and its tabs, switch active tab within a window) is a direct
 * lookup instead of a filter-all-tabs scan.
 *
 * Each window gets its own inner `SvelteMap` for tabs. Svelte 5's reactivity
 * tracks each SvelteMap independently, so mutating one window's tabs only
 * re-renders that window's `{#each}` block—not every window.
 */
type WindowState = {
	window: BrowserWindow;
	tabs: SvelteMap<number, BrowserTab>;
};

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

function createBrowserState() {
	/**
	 * Single source of truth for all browser windows and tabs.
	 *
	 * Keyed by native windowId so every lookup is O(1). The outer SvelteMap
	 * triggers reactivity when windows are added/removed; each inner SvelteMap
	 * triggers reactivity when that window's tabs change.
	 */
	const windowStates = new SvelteMap<number, WindowState>();

	/**
	 * Set to `true` only AFTER the seed populates `windowStates`.
	 * Event handlers guard with `if (!seeded) return` so events that arrive
	 * before the seed completes are silently dropped (they'd be stale anyway—
	 * the seed is the authoritative snapshot).
	 */
	let seeded = false;

	// ── Seed ─────────────────────────────────────────────────────────────
	// Single IPC call via `getAll({ populate: true })` returns windows with
	// their tabs already nested—a natural fit for our WindowState shape.

	const whenReady = (async () => {
		const browserWindows = await browser.windows.getAll({ populate: true });

		for (const win of browserWindows) {
			const bw = toBrowserWindow(win);
			if (!bw) continue;

			const tabsMap = new SvelteMap<number, BrowserTab>();
			if (win.tabs) {
				for (const tab of win.tabs) {
					const bt = toBrowserTab(tab);
					if (bt) tabsMap.set(bt.tabId, bt);
				}
			}

			windowStates.set(bw.windowId, { window: bw, tabs: tabsMap });
		}

		seeded = true;
	})();

	// ── Tab Event Listeners ──────────────────────────────────────────────

	// onCreated: Full Tab object provided
	browser.tabs.onCreated.addListener((tab) => {
		if (!seeded) return;
		const bt = toBrowserTab(tab);
		if (!bt) return;
		const state = windowStates.get(bt.windowId);
		if (!state) return;
		state.tabs.set(bt.tabId, bt);
	});

	// onRemoved: When isWindowClosing is true, the window's onRemoved handler
	// will delete the entire WindowState (and all its tabs with it).
	browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
		if (!seeded) return;
		if (removeInfo.isWindowClosing) return;
		windowStates.get(removeInfo.windowId)?.tabs.delete(tabId);
	});

	// onUpdated: Full Tab in 3rd arg—route to correct window
	browser.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
		if (!seeded) return;
		const bt = toBrowserTab(tab);
		if (!bt) return;
		const state = windowStates.get(bt.windowId);
		if (!state) return;
		state.tabs.set(bt.tabId, bt);
	});

	// onMoved: Re-query tab to get updated index
	browser.tabs.onMoved.addListener(async (tabId) => {
		if (!seeded) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const bt = toBrowserTab(tab);
			if (!bt) return;
			const state = windowStates.get(bt.windowId);
			if (!state) return;
			state.tabs.set(bt.tabId, bt);
		} catch {
			// Tab may have been closed during move
		}
	});

	// onActivated: Only scans the affected window's tabs (not all tabs across
	// all windows) to flip the active flag.
	browser.tabs.onActivated.addListener((activeInfo) => {
		if (!seeded) return;
		const state = windowStates.get(activeInfo.windowId);
		if (!state) return;

		for (const [tabId, tab] of state.tabs) {
			if (tab.active) {
				state.tabs.set(tabId, { ...tab, active: false });
			}
		}

		const tab = state.tabs.get(activeInfo.tabId);
		if (tab) {
			state.tabs.set(activeInfo.tabId, { ...tab, active: true });
		}
	});

	// ── Attach / Detach ──────────────────────────────────────────────────
	// Moving a tab between windows fires two events in order:
	//   1. onDetached (old window)—we remove the tab from the old window's map
	//   2. onAttached (new window)—we re-query the tab and add it to the new
	//      window's map (re-query is needed to get the updated windowId + index)

	browser.tabs.onAttached.addListener(async (tabId) => {
		if (!seeded) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const bt = toBrowserTab(tab);
			if (!bt) return;
			const state = windowStates.get(bt.windowId);
			if (!state) return;
			state.tabs.set(bt.tabId, bt);
		} catch {
			// Tab may have been closed
		}
	});

	browser.tabs.onDetached.addListener((tabId, detachInfo) => {
		if (!seeded) return;
		windowStates.get(detachInfo.oldWindowId)?.tabs.delete(tabId);
	});

	// ── Window Event Listeners ───────────────────────────────────────────

	// onCreated: Full Window object provided
	browser.windows.onCreated.addListener((window) => {
		if (!seeded) return;
		const bw = toBrowserWindow(window);
		if (!bw) return;
		windowStates.set(bw.windowId, { window: bw, tabs: new SvelteMap() });
	});

	// onRemoved: Deleting the WindowState entry removes the window AND all its
	// tabs in one operation—no orphan cleanup needed.
	browser.windows.onRemoved.addListener((windowId) => {
		if (!seeded) return;
		windowStates.delete(windowId);
	});

	// onFocusChanged: We call `windowStates.set()` (not just mutate the window
	// object in place) because the `window` property is a plain object, not
	// wrapped in $state. Calling `.set()` on the outer SvelteMap bumps its
	// version signal.
	browser.windows.onFocusChanged.addListener((windowId) => {
		if (!seeded) return;

		for (const [id, state] of windowStates) {
			if (state.window.focused) {
				windowStates.set(id, {
					...state,
					window: { ...state.window, focused: false },
				});
			}
		}

		// WINDOW_ID_NONE means all windows lost focus (e.g. user clicked desktop)
		if (windowId !== browser.windows.WINDOW_ID_NONE) {
			const state = windowStates.get(windowId);
			if (state) {
				windowStates.set(windowId, {
					...state,
					window: { ...state.window, focused: true },
				});
			}
		}
	});


	/** All browser windows. Cached via `$derived` so consumers don't trigger recomputation. */
	const windows = $derived(windowStates.values().toArray().map((s) => s.window));

	return {
		/**
		 * Resolves after the initial browser state seed completes.
		 *
		 * Use this to gate UI rendering so child components can safely read
		 * `windows` and `tabsByWindow` synchronously at construction time.
		 *
		 * @example
		 * ```svelte
		 * {#await browserState.whenReady}
		 *   <Spinner />
		 * {:then}
		 *   <UnifiedTabList />
		 * {:catch}
		 *   <ErrorState />
		 * {/await}
		 * ```
		 */
		whenReady,

		/** All browser windows. */
		get windows() {
			return windows;
		},

		/**
		 * Get tabs for a specific window, sorted by tab strip index.
		 *
		 * @example
		 * ```svelte
		 * {#each browserState.tabsByWindow(window.windowId) as tab (tab.tabId)}
		 *   <TabItem {tab} />
		 * {/each}
		 * ```
		 */
		tabsByWindow(windowId: number): BrowserTab[] {
			const state = windowStates.get(windowId);
			if (!state) return [];
			return state.tabs
				.values()
				.toArray()
				.sort((a, b) => a.index - b.index);
		},

		/**
		 * Close a tab. Browser onRemoved event updates state.
		 *
		 * None of these methods mutate `windowStates` directly—they call the
		 * browser API, which fires an event (e.g. `onRemoved`, `onUpdated`),
		 * and the event listener above handles the state update.
		 */
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
}

export const browserState = createBrowserState();
