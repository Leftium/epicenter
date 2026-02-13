/**
 * Browser API type conversion helpers.
 *
 * Provides a factory that creates deviceId-bound converters for browser
 * tab/window/group types to our schema row types.
 *
 * All IDs are device-scoped to prevent collisions during multi-device sync.
 *
 * @example
 * const { TabId, tabToRow } = createBrowserConverters(deviceId);
 * tables.tabs.upsert(tabToRow(tab));
 * tables.tabs.delete({ id: TabId(123) });
 */

import type { Tab, TabGroup, Window } from './epicenter/browser.schema';

/**
 * Create deviceId-bound converters and ID constructors.
 *
 * Returns both ID constructors (TabId, WindowId, GroupId) and row converters
 * (tabToRow, windowToRow, tabGroupToRow) all bound to the provided deviceId.
 *
 * @example
 * const deviceId = await getDeviceId();
 * const { TabId, WindowId, tabToRow, windowToRow } = createBrowserConverters(deviceId);
 *
 * // Convert browser objects to rows
 * tables.tabs.upsert(tabToRow(tab));
 * tables.windows.upsert(windowToRow(window));
 *
 * // Create composite IDs for lookups/deletes
 * tables.tabs.delete({ id: TabId(123) });
 */
export function createBrowserConverters(deviceId: string) {
	// ID constructors (static API uses plain strings for IDs)
	const TabId = (tabId: number): string => `${deviceId}_${tabId}`;
	const WindowId = (windowId: number): string => `${deviceId}_${windowId}`;
	const GroupId = (groupId: number): string => `${deviceId}_${groupId}`;

	return {
		// ID constructors
		TabId,
		WindowId,
		GroupId,

		/**
		 * Convert a browser tab to a schema row.
		 *
		 * Returns `null` if the tab has no ID (e.g. foreign tabs from the sessions API).
		 * Tabs without IDs can't be activated, closed, or stored with a composite key.
		 */
		tabToRow(tab: Browser.tabs.Tab): Tab | null {
			if (tab.id === undefined) return null;

			const { id, windowId, groupId, openerTabId, selected, ...rest } = tab;
			return {
				...rest,
				id: TabId(id),
				deviceId,
				tabId: id,
				windowId: WindowId(windowId),
				groupId: GroupId(groupId),
				openerTabId: openerTabId !== undefined ? TabId(openerTabId) : undefined,
			};
		},

		/**
		 * Convert a browser window to a schema row.
		 *
		 * Returns `null` if the window has no ID.
		 */
		windowToRow(window: Browser.windows.Window): Window | null {
			if (window.id === undefined) return null;

			const { id, tabs: _tabs, ...rest } = window;
			return {
				...rest,
				id: WindowId(id),
				deviceId,
				windowId: id,
			};
		},

		tabGroupToRow(group: Browser.tabGroups.TabGroup): TabGroup {
			const { id, windowId, ...rest } = group;
			return {
				...rest,
				id: GroupId(id),
				deviceId,
				groupId: id,
				windowId: WindowId(windowId),
			};
		},
	};
}
