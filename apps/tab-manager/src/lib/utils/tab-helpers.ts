/**
 * Pure tab-analysis helpers shared by the command palette.
 *
 * These functions take a tab array and return analysis results—no dependency
 * on `browserState` or any other reactive data source.
 * Consumers provide their own tab arrays from whatever source they use.
 *
 * @example
 * ```typescript
 * import { findDuplicateGroups, groupTabsByDomain } from '$lib/utils/tab-helpers';
 *
 * const dupes = findDuplicateGroups(getAllTabs());
 * ```
 */

import { getDomain } from '$lib/utils/format';

/**
 * Normalize a URL for duplicate comparison.
 *
 * Strips trailing slash, query params, and hash to treat
 * `https://github.com/foo` and `https://github.com/foo?ref=bar#readme`
 * as the same page.
 *
 * @example
 * ```typescript
 * normalizeUrl('https://github.com/foo?ref=bar#readme')
 * // 'https://github.com/foo'
 *
 * normalizeUrl('https://example.com/')
 * // 'https://example.com'
 * ```
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
 * Minimum fields needed for tab analysis helpers.
 *
 * Kept generic so tests can pass plain objects without importing
 * the full `BrowserTab` type from browser-state.
 */
type TabLike = {
	id: number;
	url?: string | undefined;
	title?: string | undefined;
};

/**
 * Find groups of tabs with the same normalized URL.
 *
 * Returns only groups with 2+ tabs (actual duplicates).
 * Within each group, tabs are ordered by their original array position,
 * so `group[0]` is the "keep" candidate and `group.slice(1)` are duplicates.
 *
 * @example
 * ```typescript
 * const tabs = [
 *   { tabId: 1, url: 'https://github.com/foo', title: 'Foo' },
 *   { tabId: 2, url: 'https://github.com/foo?ref=bar', title: 'Foo' },
 *   { tabId: 3, url: 'https://example.com', title: 'Example' },
 * ];
 *
 * const dupes = findDuplicateGroups(tabs);
 * // Map { 'https://github.com/foo' => [tab-1, tab-2] }
 * ```
 */
export function findDuplicateGroups<T extends TabLike>(
	tabs: T[],
): Map<string, T[]> {
	const byUrl = new Map<string, T[]>();

	for (const tab of tabs) {
		if (!tab.url) continue;
		const normalized = normalizeUrl(tab.url);
		const group = byUrl.get(normalized) ?? [];
		group.push(tab);
		byUrl.set(normalized, group);
	}

	return new Map([...byUrl].filter(([, group]) => group.length > 1));
}

/**
 * Group tabs by their domain (hostname).
 *
 * Returns a Map from domain string to the tabs on that domain.
 * Tabs without a URL are skipped. Includes all domains, even those
 * with a single tab—callers should filter to 2+ if needed.
 *
 * @example
 * ```typescript
 * const tabs = [
 *   { tabId: 1, url: 'https://github.com/foo' },
 *   { tabId: 2, url: 'https://github.com/bar' },
 *   { tabId: 3, url: 'https://youtube.com/watch?v=1' },
 * ];
 *
 * const domains = groupTabsByDomain(tabs);
 * // Map { 'github.com' => [tab-1, tab-2], 'youtube.com' => [tab-3] }
 * ```
 */
export function groupTabsByDomain<T extends TabLike>(
	tabs: T[],
): Map<string, T[]> {
	const byDomain = new Map<string, T[]>();

	for (const tab of tabs) {
		if (!tab.url) continue;
		const domain = getDomain(tab.url);
		if (!domain) continue;
		const group = byDomain.get(domain) ?? [];
		group.push(tab);
		byDomain.set(domain, group);
	}

	return byDomain;
}
