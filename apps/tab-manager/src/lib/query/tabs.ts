/**
 * TanStack Query integration for tabs.
 *
 * Queries read directly from Chrome APIs - Chrome is the source of truth.
 * Chrome events (subscribed via chrome-events.ts) invalidate queries for live updates.
 * Mutations call Chrome APIs directly; changes propagate via Chrome events.
 */

import { createTaggedError } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { getDeviceId } from '$lib/device-id';
import {
	tabGroupToRow,
	tabToRow,
	windowToRow,
} from '$lib/epicenter/browser.schema';
import { defineMutation, defineQuery } from './_client';

// ─────────────────────────────────────────────────────────────────────────────
// Query Keys
// ─────────────────────────────────────────────────────────────────────────────

export const tabsKeys = {
	all: ['tabs'] as const,
	windows: ['windows'] as const,
	tabGroups: ['tabGroups'] as const,
	byWindow: (windowId: string) => ['tabs', 'window', windowId] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

const { TabsErr } = createTaggedError('TabsError');

// ─────────────────────────────────────────────────────────────────────────────
// Query and Mutation Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tab queries and mutations.
 *
 * Queries hit Chrome APIs directly - no Y.Doc intermediary.
 * Chrome events invalidate queries for live updates.
 * Mutations call Chrome APIs directly; changes propagate via Chrome events.
 */
export const tabs = {
	// ─────────────────────────────────────────────────────────────────────────
	// Queries - Read directly from Chrome APIs
	// ─────────────────────────────────────────────────────────────────────────

	getAll: defineQuery({
		queryKey: tabsKeys.all,
		queryFn: async () => {
			const deviceId = await getDeviceId();
			const browserTabs = await browser.tabs.query({});
			const rows = browserTabs
				.flatMap((tab) => {
					const row = tabToRow(deviceId, tab);
					return row ? [row] : [];
				})
				.sort((a, b) => a.index - b.index);
			return Ok(rows);
		},
		// Browser is always fresh. Data is only stale when browser events tell us.
		// Using Infinity means we only refetch on explicit invalidation.
		staleTime: Infinity,
	}),

	getAllWindows: defineQuery({
		queryKey: tabsKeys.windows,
		queryFn: async () => {
			const deviceId = await getDeviceId();
			const browserWindows = await browser.windows.getAll();
			const rows = browserWindows.flatMap((win) => {
				const row = windowToRow(deviceId, win);
				return row ? [row] : [];
			});
			return Ok(rows);
		},
		staleTime: Infinity,
	}),

	getAllTabGroups: defineQuery({
		queryKey: tabsKeys.tabGroups,
		queryFn: async () => {
			// Tab groups are Chrome 88+ only
			if (!browser.tabGroups) {
				return Ok([]);
			}
			const deviceId = await getDeviceId();
			const browserGroups = await browser.tabGroups.query({});
			return Ok(browserGroups.map((group) => tabGroupToRow(deviceId, group)));
		},
		staleTime: Infinity,
	}),

	// ─────────────────────────────────────────────────────────────────────────
	// Mutations - Call Chrome APIs directly
	// ─────────────────────────────────────────────────────────────────────────

	close: defineMutation({
		mutationKey: ['tabs', 'close'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: async () => {
					await browser.tabs.remove(tabId);
				},
				catch: (e) => TabsErr({ message: `Failed to close tab: ${e}` }),
			}),
	}),

	activate: defineMutation({
		mutationKey: ['tabs', 'activate'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: async () => {
					const tab = await browser.tabs.update(tabId, { active: true });
					if (tab?.windowId) {
						await browser.windows.update(tab.windowId, { focused: true });
					}
					return tab;
				},
				catch: (e) => TabsErr({ message: `Failed to activate tab: ${e}` }),
			}),
	}),

	pin: defineMutation({
		mutationKey: ['tabs', 'pin'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: () => browser.tabs.update(tabId, { pinned: true }),
				catch: (e) => TabsErr({ message: `Failed to pin tab: ${e}` }),
			}),
	}),

	unpin: defineMutation({
		mutationKey: ['tabs', 'unpin'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: () => browser.tabs.update(tabId, { pinned: false }),
				catch: (e) => TabsErr({ message: `Failed to unpin tab: ${e}` }),
			}),
	}),

	mute: defineMutation({
		mutationKey: ['tabs', 'mute'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: () => browser.tabs.update(tabId, { muted: true }),
				catch: (e) => TabsErr({ message: `Failed to mute tab: ${e}` }),
			}),
	}),

	unmute: defineMutation({
		mutationKey: ['tabs', 'unmute'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: () => browser.tabs.update(tabId, { muted: false }),
				catch: (e) => TabsErr({ message: `Failed to unmute tab: ${e}` }),
			}),
	}),

	reload: defineMutation({
		mutationKey: ['tabs', 'reload'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: async () => {
					await browser.tabs.reload(tabId);
				},
				catch: (e) => TabsErr({ message: `Failed to reload tab: ${e}` }),
			}),
	}),

	duplicate: defineMutation({
		mutationKey: ['tabs', 'duplicate'],
		mutationFn: (tabId: number) =>
			tryAsync({
				try: () => browser.tabs.duplicate(tabId),
				catch: (e) => TabsErr({ message: `Failed to duplicate tab: ${e}` }),
			}),
	}),
};
