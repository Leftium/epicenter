/**
 * Row converters for transforming Browser API objects to schema rows.
 *
 * These pure functions convert `chrome.tabs.Tab`, `chrome.windows.Window`,
 * and `chrome.tabGroups.TabGroup` into their Yjs table row equivalents.
 */

import {
	createGroupCompositeId,
	createTabCompositeId,
	createWindowCompositeId,
} from '$lib/device/composite-id';
import type { Tab, TabGroup, Window } from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Row Converters (Browser API → Schema Row)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a browser tab to a schema row.
 *
 * Returns `null` if the tab has no ID (e.g. foreign tabs from the sessions API).
 * Tabs without IDs can't be activated, closed, or stored with a composite key.
 *
 * @example
 * ```typescript
 * const row = tabToRow(deviceId, tab);
 * if (row) tables.tabs.set(row);
 * ```
 */
export function tabToRow(deviceId: string, tab: Browser.tabs.Tab): Tab | null {
	if (tab.id === undefined) return null;

	const { id, windowId, groupId, openerTabId, selected, ...rest } = tab;
	return {
		...rest,
		id: createTabCompositeId(deviceId, id),
		deviceId,
		tabId: id,
		windowId: createWindowCompositeId(deviceId, windowId),
		groupId: createGroupCompositeId(deviceId, groupId),
		openerTabId:
			openerTabId !== undefined
				? createTabCompositeId(deviceId, openerTabId)
				: undefined,
		_v: 1,
	};
}

/**
 * Convert a browser window to a schema row.
 *
 * Returns `null` if the window has no ID.
 *
 * @example
 * ```typescript
 * const row = windowToRow(deviceId, window);
 * if (row) tables.windows.set(row);
 * ```
 */
export function windowToRow(
	deviceId: string,
	window: Browser.windows.Window,
): Window | null {
	if (window.id === undefined) return null;

	const { id, tabs: _tabs, ...rest } = window;
	return {
		...rest,
		id: createWindowCompositeId(deviceId, id),
		deviceId,
		windowId: id,
		_v: 1,
	};
}

/**
 * Convert a browser tab group to a schema row.
 *
 * @example
 * ```typescript
 * const row = tabGroupToRow(deviceId, group);
 * tables.tabGroups.set(row);
 * ```
 */
export function tabGroupToRow(
	deviceId: string,
	group: Browser.tabGroups.TabGroup,
): TabGroup {
	const { id, windowId, ...rest } = group;
	return {
		...rest,
		id: createGroupCompositeId(deviceId, id),
		deviceId,
		groupId: id,
		windowId: createWindowCompositeId(deviceId, windowId),
		_v: 1,
	};
}
