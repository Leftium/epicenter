/**
 * TanStack Query integration for suspended tabs.
 *
 * Unlike live tab queries (which read from Chrome APIs), suspended tab queries
 * read from the Y.Doc via the popup workspace client. The Y.Doc is the source
 * of truth for suspended tabs since they don't exist in the browser.
 *
 * Mutations call the suspend/restore helpers which write to Y.Doc and
 * interact with Chrome APIs as needed.
 */

import { createTaggedError } from 'wellcrafted/error';
import { Ok, tryAsync, trySync } from 'wellcrafted/result';
import { getDeviceId } from '$lib/device-id';
import type { SuspendedTab, Tab } from '$lib/epicenter/browser.schema';
import {
	deleteSuspendedTab,
	restoreTab,
	suspendTab,
	updateSuspendedTab,
} from '$lib/epicenter/suspend-tab';
import { popupWorkspace } from '$lib/epicenter/workspace';
import { defineMutation, defineQuery } from './_client';

// ─────────────────────────────────────────────────────────────────────────────
// Query Keys
// ─────────────────────────────────────────────────────────────────────────────

export const suspendedTabsKeys = {
	all: ['suspended-tabs'] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

const { SuspendedTabsErr } = createTaggedError('SuspendedTabsError');

// ─────────────────────────────────────────────────────────────────────────────
// Query and Mutation Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Suspended tab queries and mutations.
 *
 * Queries read from Y.Doc (not Chrome APIs).
 * Mutations write to Y.Doc and optionally call Chrome APIs.
 */
export const suspendedTabs = {
	// ─────────────────────────────────────────────────────────────────────────
	// Queries — Read from Y.Doc
	// ─────────────────────────────────────────────────────────────────────────

	getAll: defineQuery({
		queryKey: suspendedTabsKeys.all,
		queryFn: () => {
			const rows = popupWorkspace.tables.suspended_tabs
				.getAllValid()
				.sort((a, b) => b.suspended_at - a.suspended_at);
			return Ok(rows);
		},
	}),

	// ─────────────────────────────────────────────────────────────────────────
	// Mutations — Write to Y.Doc + Chrome APIs
	// ─────────────────────────────────────────────────────────────────────────

	suspend: defineMutation({
		mutationKey: ['suspended-tabs', 'suspend'],
		mutationFn: (tab: Tab) =>
			tryAsync({
				try: async () => {
					const deviceId = await getDeviceId();
					await suspendTab(popupWorkspace.tables, deviceId, tab);
				},
				catch: (e) =>
					SuspendedTabsErr({ message: `Failed to suspend tab: ${e}` }),
			}),
	}),

	restore: defineMutation({
		mutationKey: ['suspended-tabs', 'restore'],
		mutationFn: (suspendedTab: SuspendedTab) =>
			tryAsync({
				try: async () => {
					await restoreTab(popupWorkspace.tables, suspendedTab);
				},
				catch: (e) =>
					SuspendedTabsErr({ message: `Failed to restore tab: ${e}` }),
			}),
	}),

	restoreAll: defineMutation({
		mutationKey: ['suspended-tabs', 'restore-all'],
		mutationFn: () =>
			tryAsync({
				try: async () => {
					const all = popupWorkspace.tables.suspended_tabs.getAllValid();
					for (const tab of all) {
						await restoreTab(popupWorkspace.tables, tab);
					}
				},
				catch: (e) =>
					SuspendedTabsErr({
						message: `Failed to restore all tabs: ${e}`,
					}),
			}),
	}),

	remove: defineMutation({
		mutationKey: ['suspended-tabs', 'remove'],
		mutationFn: async (id: string) =>
			trySync({
				try: () => {
					deleteSuspendedTab(popupWorkspace.tables, id);
				},
				catch: (e) =>
					SuspendedTabsErr({
						message: `Failed to delete suspended tab: ${e}`,
					}),
			}),
	}),

	removeAll: defineMutation({
		mutationKey: ['suspended-tabs', 'remove-all'],
		mutationFn: async () =>
			trySync({
				try: () => {
					const all = popupWorkspace.tables.suspended_tabs.getAllValid();
					for (const tab of all) {
						deleteSuspendedTab(popupWorkspace.tables, tab.id);
					}
				},
				catch: (e) =>
					SuspendedTabsErr({
						message: `Failed to delete all suspended tabs: ${e}`,
					}),
			}),
	}),

	update: defineMutation({
		mutationKey: ['suspended-tabs', 'update'],
		mutationFn: async (suspendedTab: SuspendedTab) =>
			trySync({
				try: () => {
					updateSuspendedTab(popupWorkspace.tables, suspendedTab);
				},
				catch: (e) =>
					SuspendedTabsErr({
						message: `Failed to update suspended tab: ${e}`,
					}),
			}),
	}),
};
