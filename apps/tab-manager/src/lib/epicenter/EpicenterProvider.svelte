<!--
	ChromeEventsProvider - Chrome event subscription for live UI updates.

	Subscribes to Chrome browser events on mount and invalidates TanStack Query
	cache when tabs/windows change. No Y.Doc sync needed - Chrome is the source
	of truth, and queries read directly from Chrome APIs.

	The popup renders immediately - no waiting for background sync.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount, onDestroy } from 'svelte';
	import { queryClient } from '$lib/query/_client';
	import { tabsKeys } from '$lib/query/tabs';

	let { children }: { children: Snippet } = $props();

	let unsubscribe: (() => void) | null = null;

	onMount(() => {
		unsubscribe = subscribeToChromeBrowserEvents();
	});

	onDestroy(() => {
		unsubscribe?.();
	});

	/**
	 * Subscribe to Chrome browser events for live UI updates.
	 *
	 * When Chrome tabs/windows change, the relevant TanStack Query cache is
	 * invalidated, causing active queries to refetch from Chrome APIs.
	 *
	 * @returns Cleanup function to unsubscribe all listeners
	 */
	function subscribeToChromeBrowserEvents(): () => void {
		const invalidateTabs = () =>
			queryClient.invalidateQueries({ queryKey: tabsKeys.all });
		const invalidateWindows = () =>
			queryClient.invalidateQueries({ queryKey: tabsKeys.windows });
		const invalidateGroups = () =>
			queryClient.invalidateQueries({ queryKey: tabsKeys.tabGroups });

		// ─────────────────────────────────────────────────────────────────────────
		// Tab Events
		// ─────────────────────────────────────────────────────────────────────────

		browser.tabs.onCreated.addListener(invalidateTabs);
		browser.tabs.onRemoved.addListener(invalidateTabs);
		browser.tabs.onUpdated.addListener(invalidateTabs);
		browser.tabs.onMoved.addListener(invalidateTabs);
		browser.tabs.onActivated.addListener(invalidateTabs);
		browser.tabs.onAttached.addListener(invalidateTabs);
		browser.tabs.onDetached.addListener(invalidateTabs);

		// ─────────────────────────────────────────────────────────────────────────
		// Window Events
		// ─────────────────────────────────────────────────────────────────────────

		browser.windows.onCreated.addListener(invalidateWindows);
		browser.windows.onRemoved.addListener(invalidateWindows);
		browser.windows.onFocusChanged.addListener(invalidateWindows);

		// ─────────────────────────────────────────────────────────────────────────
		// Tab Group Events (Chrome 88+ only)
		// ─────────────────────────────────────────────────────────────────────────

		if (browser.tabGroups) {
			browser.tabGroups.onCreated.addListener(invalidateGroups);
			browser.tabGroups.onRemoved.addListener(invalidateGroups);
			browser.tabGroups.onUpdated.addListener(invalidateGroups);
		}

		console.log('[ChromeEvents] Subscribed to browser events');

		// Return cleanup function
		return () => {
			browser.tabs.onCreated.removeListener(invalidateTabs);
			browser.tabs.onRemoved.removeListener(invalidateTabs);
			browser.tabs.onUpdated.removeListener(invalidateTabs);
			browser.tabs.onMoved.removeListener(invalidateTabs);
			browser.tabs.onActivated.removeListener(invalidateTabs);
			browser.tabs.onAttached.removeListener(invalidateTabs);
			browser.tabs.onDetached.removeListener(invalidateTabs);

			browser.windows.onCreated.removeListener(invalidateWindows);
			browser.windows.onRemoved.removeListener(invalidateWindows);
			browser.windows.onFocusChanged.removeListener(invalidateWindows);

			if (browser.tabGroups) {
				browser.tabGroups.onCreated.removeListener(invalidateGroups);
				browser.tabGroups.onRemoved.removeListener(invalidateGroups);
				browser.tabGroups.onUpdated.removeListener(invalidateGroups);
			}

			console.log('[ChromeEvents] Unsubscribed from browser events');
		};
	}
</script>

{@render children()}
