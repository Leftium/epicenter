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

		// Row converters — spread Browser objects, only override transformed fields
		tabToRow(tab: Browser.tabs.Tab & { id: number; windowId: number }): Tab {
			const {
				id,
				windowId,
				groupId,
				openerTabId,
				mutedInfo,
				selected,
				...rest
			} = tab;
			return {
				...rest,
				id: TabId(id),
				deviceId,
				tabId: id,
				windowId: WindowId(windowId),
				status: rest.status as Tab['status'],
				muted: mutedInfo?.muted,
				groupId:
					groupId !== undefined && groupId !== -1
						? GroupId(groupId)
						: undefined,
				openerTabId: openerTabId !== undefined ? TabId(openerTabId) : undefined,
			};
		},

		windowToRow(window: Browser.windows.Window & { id: number }): Window {
			const { id, tabs: _tabs, ...rest } = window;
			return {
				...rest,
				id: WindowId(id),
				deviceId,
				windowId: id,
				state: rest.state as Window['state'],
				type: rest.type as Window['type'],
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
				color: rest.color as TabGroup['color'],
			};
		},
	};
}
