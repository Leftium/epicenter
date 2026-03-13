/**
 * Quick action registry for the command palette.
 *
 * Each action has a label, description, icon, and execute function.
 * Dangerous actions show a confirmation dialog before executing.
 * Actions read from {@link browserState} and call Chrome APIs via
 * the existing `actions.ts` helpers.
 *
 * @example
 * ```typescript
 * import { quickActions } from '$lib/quick-actions';
 *
 * for (const action of quickActions) {
 *   console.log(action.label, action.description);
 * }
 * ```
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import ArrowDownAZIcon from '@lucide/svelte/icons/arrow-down-a-z';
import CopyMinusIcon from '@lucide/svelte/icons/copy-minus';
import GlobeIcon from '@lucide/svelte/icons/globe';
import GroupIcon from '@lucide/svelte/icons/group';
import type { Component } from 'svelte';
import { Ok, tryAsync } from 'wellcrafted/result';
import { browserState } from '$lib/state/browser-state.svelte';
import { savedTabState } from '$lib/state/saved-tab-state.svelte';
import { getDomain } from '$lib/utils/format';
import type { TabCompositeId } from '$lib/workspace';
import { parseTabId } from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QuickAction = {
	id: string;
	label: string;
	description: string;
	icon: Component;
	keywords: string[];
	execute: () => Promise<void> | void;
	/** When true, execute shows a confirmation dialog before running. */
	dangerous?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Batch-resolve composite tab IDs to native Chrome tab IDs.
 */
function compositeToNativeIds(compositeIds: TabCompositeId[]): number[] {
	return compositeIds
		.map((id) => parseTabId(id)?.tabId)
		.filter((id) => id !== undefined);
}

/**
 * Normalize a URL for duplicate comparison.
 *
 * Strips trailing slash, query params, and hash to treat
 * `https://github.com/foo` and `https://github.com/foo?ref=bar#readme`
 * as the same page.
 */
function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.origin + parsed.pathname.replace(/\/$/, '');
	} catch {
		return url;
	}
}

/**
 * Find groups of tabs with the same normalized URL.
 *
 * Returns only groups with 2+ tabs (actual duplicates).
 * Within each group, tabs are ordered by their original array position.
 */
function findDuplicates(): Map<string, { tabId: TabCompositeId; title: string }[]> {
	const byUrl = new Map<string, { tabId: TabCompositeId; title: string }[]>();

	for (const window of browserState.windows) {
		for (const tab of browserState.tabsByWindow(window.id)) {
			if (!tab.url) continue;
			const normalized = normalizeUrl(tab.url);
			const group = byUrl.get(normalized) ?? [];
			group.push({ tabId: tab.id, title: tab.title ?? 'Untitled' });
			byUrl.set(normalized, group);
		}
	}

	return new Map([...byUrl].filter(([, group]) => group.length > 1));
}

/**
 * Get all tabs across all windows as a flat array.
 */
function getAllTabs() {
	return browserState.windows.flatMap((w) => browserState.tabsByWindow(w.id));
}

/**
 * Get unique domains from all open tabs.
 */
function getUniqueDomains(): Map<string, TabCompositeId[]> {
	const byDomain = new Map<string, TabCompositeId[]>();

	for (const tab of getAllTabs()) {
		if (!tab.url) continue;
		const domain = getDomain(tab.url);
		if (!domain) continue;
		const ids = byDomain.get(domain) ?? [];
		ids.push(tab.id);
		byDomain.set(domain, ids);
	}

	return byDomain;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

const dedupAction: QuickAction = {
	id: 'dedup',
	label: 'Remove Duplicates',
	description: 'Close duplicate tabs with the same URL',
	icon: CopyMinusIcon,
	keywords: ['dedup', 'duplicate', 'remove', 'close', 'clean'],
	dangerous: true,
	execute() {
		const dupes = findDuplicates();
		if (dupes.size === 0) return;

		const totalDuplicates = [...dupes.values()].reduce(
			(sum, group) => sum + group.length - 1,
			0,
		);

		// Collect the tab IDs to close (all but the first in each group)
		const toClose = [...dupes.values()].flatMap((group) =>
			group.slice(1).map((t) => t.tabId),
		);

		confirmationDialog.open({
			title: 'Remove Duplicate Tabs',
			description: `Found ${totalDuplicates} duplicate tab${totalDuplicates === 1 ? '' : 's'} across ${dupes.size} URL${dupes.size === 1 ? '' : 's'}. Close them?`,
			confirm: { text: 'Close Duplicates', variant: 'destructive' },
			async onConfirm() {
				const nativeIds = compositeToNativeIds(toClose);
				await tryAsync({
					try: () => browser.tabs.remove(nativeIds),
					catch: () => Ok(undefined),
				});
			},
		});
	},
};

const sortAction: QuickAction = {
	id: 'sort',
	label: 'Sort Tabs by Title',
	description: 'Sort tabs alphabetically within each window',
	icon: ArrowDownAZIcon,
	keywords: ['sort', 'alphabetical', 'order', 'organize'],
	async execute() {
		for (const window of browserState.windows) {
			const tabs = browserState.tabsByWindow(window.id);
			const sorted = [...tabs].sort((a, b) =>
				(a.title ?? '').localeCompare(b.title ?? ''),
			);

			for (let i = 0; i < sorted.length; i++) {
				const tab = sorted[i];
				if (!tab) continue;
				const parsed = parseTabId(tab.id);
				if (!parsed) continue;
				await tryAsync({
					try: () => browser.tabs.move(parsed.tabId, { index: i }),
					catch: () => Ok(undefined),
				});
			}
		}
	},
};

const groupByDomainAction: QuickAction = {
	id: 'group-by-domain',
	label: 'Group Tabs by Domain',
	description: 'Create tab groups based on website domain',
	icon: GroupIcon,
	keywords: ['group', 'domain', 'organize', 'categorize'],
	async execute() {
		const domains = getUniqueDomains();

		const groupOps = [...domains.entries()]
			.filter(([, tabIds]) => tabIds.length >= 2)
			.map(([domain, tabIds]) => {
				const nativeIds = compositeToNativeIds(tabIds);
				return nativeIds.length >= 2 ? { domain, nativeIds } : null;
			})
			.filter(
				(op) => op !== null,
			);

		await Promise.allSettled(
			groupOps.map(async ({ domain, nativeIds }) => {
				const groupId = await browser.tabs.group({
					tabIds: nativeIds as [number, ...number[]],
				});
				await browser.tabGroups.update(groupId, { title: domain });
			}),
		);
	},
};

const saveAllAction: QuickAction = {
	id: 'save-all',
	label: 'Save All Tabs',
	description: 'Save all open tabs for later and close them',
	icon: ArchiveIcon,
	keywords: ['save', 'all', 'close', 'stash', 'park'],
	dangerous: true,
	execute() {
		const allTabs = getAllTabs();
		if (allTabs.length === 0) return;

		confirmationDialog.open({
			title: 'Save All Tabs',
			description: `Save and close ${allTabs.length} tab${allTabs.length === 1 ? '' : 's'}?`,
			confirm: { text: 'Save & Close All', variant: 'destructive' },
			async onConfirm() {
				const tabsWithUrls = allTabs.filter((tab) => tab.url);
				await Promise.allSettled(
					tabsWithUrls.map((tab) => savedTabState.actions.save(tab)),
				);
			},
		});
	},
};

const closeByDomainAction: QuickAction = {
	id: 'close-by-domain',
	label: 'Close Tabs by Domain',
	description: 'Close all tabs from a specific domain',
	icon: GlobeIcon,
	keywords: ['close', 'domain', 'website', 'remove'],
	execute() {
		// This action needs a domain picker—for now it closes tabs from the most common domain
		const domains = getUniqueDomains();
		if (domains.size === 0) return;

		// Find the domain with the most tabs
		let topDomain = '';
		let topCount = 0;
		for (const [domain, ids] of domains) {
			if (ids.length > topCount) {
				topDomain = domain;
				topCount = ids.length;
			}
		}

		const tabIds = domains.get(topDomain) ?? [];

		confirmationDialog.open({
			title: `Close ${topDomain} Tabs`,
			description: `Close ${topCount} tab${topCount === 1 ? '' : 's'} from ${topDomain}?`,
			confirm: { text: 'Close Tabs', variant: 'destructive' },
			async onConfirm() {
				const nativeIds = compositeToNativeIds(tabIds);
				await tryAsync({
					try: () => browser.tabs.remove(nativeIds),
					catch: () => Ok(undefined),
				});
			},
		});
	},
};

/**
 * All registered quick actions for the command palette.
 *
 * Actions are ordered by expected frequency of use.
 */
export const quickActions: QuickAction[] = [
	dedupAction,
	groupByDomainAction,
	sortAction,
	closeByDomainAction,
	saveAllAction,
];
