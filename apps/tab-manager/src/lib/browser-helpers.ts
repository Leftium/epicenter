/**
 * Browser API type conversion helpers.
 *
 * Provides a factory that creates deviceId-bound converters for browser
 * tab/window/group types to our schema row types.
 *
 * All IDs are device-scoped to prevent collisions during multi-device sync.
 *
 * @example
 * const { toTabId, tabToRow } = createBrowserConverters(deviceId);
 * tables.tabs.set(tabToRow(tab));
 * tables.tabs.delete(toTabId(123));
 */

import type {
	GroupCompositeId,
	Tab,
	TabCompositeId,
	TabGroup,
	Window,
	WindowCompositeId,
} from './epicenter/browser.schema';

/**
 * Create deviceId-bound converters and ID constructors.
 *
 * Returns both ID constructors (toTabId, toWindowId, toGroupId) and row converters
 * (tabToRow, windowToRow, tabGroupToRow) all bound to the provided deviceId.
 *
 * @example
 * const deviceId = await getDeviceId();
 * const { toTabId, toWindowId, tabToRow, windowToRow } = createBrowserConverters(deviceId);
 *
 * // Convert browser objects to rows
 * tables.tabs.set(tabToRow(tab));
 * tables.windows.set(windowToRow(window));
 *
 * // Create composite IDs for lookups/deletes
 * tables.tabs.delete(toTabId(123));
 */
export function createBrowserConverters(deviceId: string) {
	/**
	 * Create a device-scoped composite tab ID.
	 *
	 * @example toTabId(123) // "deviceId_123" as TabCompositeId
	 */
	const toTabId = (tabId: number): TabCompositeId =>
		`${deviceId}_${tabId}` as TabCompositeId;

	/**
	 * Create a device-scoped composite window ID.
	 *
	 * @example toWindowId(456) // "deviceId_456" as WindowCompositeId
	 */
	const toWindowId = (windowId: number): WindowCompositeId =>
		`${deviceId}_${windowId}` as WindowCompositeId;

	/**
	 * Create a device-scoped composite group ID.
	 *
	 * @example toGroupId(789) // "deviceId_789" as GroupCompositeId
	 */
	const toGroupId = (groupId: number): GroupCompositeId =>
		`${deviceId}_${groupId}` as GroupCompositeId;

	return {
		// ID constructors
		toTabId,
		toWindowId,
		toGroupId,

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
				id: toTabId(id),
				deviceId,
				tabId: id,
				windowId: toWindowId(windowId),
				groupId: toGroupId(groupId),
				openerTabId:
					openerTabId !== undefined ? toTabId(openerTabId) : undefined,
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
				id: toWindowId(id),
				deviceId,
				windowId: id,
			};
		},

		tabGroupToRow(group: Browser.tabGroups.TabGroup): TabGroup {
			const { id, windowId, ...rest } = group;
			return {
				...rest,
				id: toGroupId(id),
				deviceId,
				groupId: id,
				windowId: toWindowId(windowId),
			};
		},
	};
}
