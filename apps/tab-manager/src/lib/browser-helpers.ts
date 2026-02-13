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

		// Row converters
		tabToRow(tab: Browser.tabs.Tab & { id: number; windowId: number }): Tab {
			return {
				id: TabId(tab.id),
				deviceId: deviceId,
				tabId: tab.id,
				windowId: WindowId(tab.windowId),
				index: tab.index,
				pinned: tab.pinned,
				active: tab.active,
				highlighted: tab.highlighted,
				incognito: tab.incognito,
				discarded: tab.discarded,
				autoDiscardable: tab.autoDiscardable,
				frozen: tab.frozen,
				// Optional fields — pass through as-is, no fake defaults
				url: tab.url,
				title: tab.title,
				favIconUrl: tab.favIconUrl,
				pendingUrl: tab.pendingUrl,
				status: tab.status as Tab['status'],
				audible: tab.audible,
				muted: tab.mutedInfo?.muted,
				groupId:
					tab.groupId !== undefined && tab.groupId !== -1
						? GroupId(tab.groupId)
						: undefined,
				openerTabId:
					tab.openerTabId !== undefined ? TabId(tab.openerTabId) : undefined,
				lastAccessed: tab.lastAccessed,
				height: tab.height,
				width: tab.width,
				sessionId: tab.sessionId,
			};
		},

		windowToRow(window: Browser.windows.Window & { id: number }): Window {
			return {
				id: WindowId(window.id),
				deviceId: deviceId,
				windowId: window.id,
				focused: window.focused,
				alwaysOnTop: window.alwaysOnTop,
				incognito: window.incognito,
				// Optional fields — pass through as-is, no fake defaults
				state: window.state as Window['state'],
				type: window.type as Window['type'],
				top: window.top,
				left: window.left,
				width: window.width,
				height: window.height,
				sessionId: window.sessionId,
			};
		},

		tabGroupToRow(group: Browser.tabGroups.TabGroup): TabGroup {
			return {
				id: GroupId(group.id),
				deviceId: deviceId,
				groupId: group.id,
				windowId: WindowId(group.windowId),
				collapsed: group.collapsed,
				color: group.color as TabGroup['color'],
				shared: group.shared,
				// Optional fields
				title: group.title,
			};
		},
	};
}
