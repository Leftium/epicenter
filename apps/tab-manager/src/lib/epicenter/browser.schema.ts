/**
 * Shared browser schema for tabs and windows.
 *
 * This schema is used by all three workspaces:
 * - Background (Chrome event listeners, Chrome API sync)
 * - Popup (UI, syncs with background via chrome.runtime)
 * - Server (persistence, multi-device sync)
 *
 * The schema mirrors Chrome's Tab and Window APIs closely.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */

import { defineTable, type InferTableRow } from '@epicenter/hq/static';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// ─────────────────────────────────────────────────────────────────────────────
// Branded Composite ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Prevents accidental mixing with plain strings, window IDs, or group IDs.
 *
 * @example
 * ```typescript
 * // As a type annotation
 * function getTab(id: TabCompositeId): Tab { ... }
 *
 * // As a runtime validator (arktype schema) in table definitions
 * const tabs = defineTable(type({ id: TabCompositeId, ... }));
 *
 * // To construct a new composite ID, use createTabCompositeId
 * const id = createTabCompositeId(deviceId, 123);
 * ```
 */
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export const TabCompositeId = type('string').pipe(
	(s): TabCompositeId => s as TabCompositeId,
);

/**
 * Device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or group IDs.
 *
 * @example
 * ```typescript
 * // As a type annotation
 * function getWindow(id: WindowCompositeId): Window { ... }
 *
 * // As a runtime validator (arktype schema) in table definitions
 * const windows = defineTable(type({ id: WindowCompositeId, ... }));
 *
 * // To construct a new composite ID, use createWindowCompositeId
 * const id = createWindowCompositeId(deviceId, 456);
 * ```
 */
export type WindowCompositeId = string & Brand<'WindowCompositeId'>;
export const WindowCompositeId = type('string').pipe(
	(s): WindowCompositeId => s as WindowCompositeId,
);

/**
 * Device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or window IDs.
 *
 * @example
 * ```typescript
 * // As a type annotation
 * function getGroup(id: GroupCompositeId): TabGroup { ... }
 *
 * // As a runtime validator (arktype schema) in table definitions
 * const tabGroups = defineTable(type({ id: GroupCompositeId, ... }));
 *
 * // To construct a new composite ID, use createGroupCompositeId
 * const id = createGroupCompositeId(deviceId, 789);
 * ```
 */
export type GroupCompositeId = string & Brand<'GroupCompositeId'>;
export const GroupCompositeId = type('string').pipe(
	(s): GroupCompositeId => s as GroupCompositeId,
);

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions (Static API with Arktype)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devices table - tracks browser installations for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID collisions.
 */
const devices = defineTable(
	type({
		id: 'string', // NanoID, generated once on install
		name: 'string', // User-editable: "Chrome on macOS", "Firefox on Windows"
		lastSeen: 'string', // ISO timestamp, updated on each sync
		browser: 'string', // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
	}),
);

/**
 * Tabs table - shadows browser tab state.
 *
 * Near 1:1 mapping with `chrome.tabs.Tab`. Optional fields match Chrome's optionality.
 * The `id` field is a composite key: `${deviceId}_${tabId}`.
 * This prevents collisions when syncing across multiple devices.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 */
const tabs = defineTable(
	type({
		id: TabCompositeId, // Composite: `${deviceId}_${tabId}`
		deviceId: 'string', // Foreign key to devices table
		tabId: 'number', // Original chrome.tabs.Tab.id for API calls
		windowId: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		index: 'number', // Zero-based position in tab strip
		pinned: 'boolean',
		active: 'boolean',
		highlighted: 'boolean',
		incognito: 'boolean',
		discarded: 'boolean', // Tab unloaded to save memory
		autoDiscardable: 'boolean',
		frozen: 'boolean', // Chrome 132+, tab cannot execute tasks
		// Optional fields — matching chrome.tabs.Tab optionality
		'url?': 'string',
		'title?': 'string',
		'favIconUrl?': 'string',
		'pendingUrl?': 'string', // Chrome 79+, URL before commit
		'status?': "'unloaded' | 'loading' | 'complete'",
		'audible?': 'boolean', // Chrome 45+
		/** @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-MutedInfo */
		'mutedInfo?': type({
			/** Whether the tab is muted (prevented from playing sound). The tab may be muted even if it has not played or is not currently playing sound. Equivalent to whether the 'muted' audio indicator is showing. */
			muted: 'boolean',
			/** The reason the tab was muted or unmuted. Not set if the tab's mute state has never been changed. */
			'reason?': "'user' | 'capture' | 'extension'",
			/** The ID of the extension that changed the muted state. Not set if an extension was not the reason the muted state last changed. */
			'extensionId?': 'string',
		}),
		'groupId?': GroupCompositeId, // Composite: `${deviceId}_${groupId}`, Chrome 88+
		'openerTabId?': TabCompositeId, // Composite: `${deviceId}_${openerTabId}`
		'lastAccessed?': 'number', // Chrome 121+, ms since epoch
		'height?': 'number',
		'width?': 'number',
		'sessionId?': 'string', // From chrome.sessions API
	}),
);

/**
 * Windows table - shadows browser window state.
 *
 * Near 1:1 mapping with `chrome.windows.Window`. Optional fields match Chrome's optionality.
 * The `id` field is a composite key: `${deviceId}_${windowId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */
const windows = defineTable(
	type({
		id: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		deviceId: 'string', // Foreign key to devices table
		windowId: 'number', // Original browser window ID for API calls
		focused: 'boolean',
		alwaysOnTop: 'boolean',
		incognito: 'boolean',
		// Optional fields — matching chrome.windows.Window optionality
		'state?':
			"'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen'",
		'type?': "'normal' | 'popup' | 'panel' | 'app' | 'devtools'",
		'top?': 'number',
		'left?': 'number',
		'width?': 'number',
		'height?': 'number',
		'sessionId?': 'string', // From chrome.sessions API
	}),
);

/**
 * Tab groups table - Chrome 88+ only, not supported on Firefox.
 *
 * The `id` field is a composite key: `${deviceId}_${groupId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups
 */
const tabGroups = defineTable(
	type({
		id: GroupCompositeId, // Composite: `${deviceId}_${groupId}`
		deviceId: 'string', // Foreign key to devices table
		groupId: 'number', // Original browser group ID for API calls
		windowId: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		collapsed: 'boolean',
		color:
			"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'",
		shared: 'boolean', // Chrome 137+
		// Optional fields — matching chrome.tabGroups.TabGroup optionality
		'title?': 'string',
	}),
);

/**
 * Suspended tabs table — explicitly saved tabs that can be restored later.
 *
 * Unlike the `tabs` table (which mirrors live browser state and is device-owned),
 * suspended tabs are shared across all devices. Any device can read, edit, or
 * restore a suspended tab.
 *
 * Created when a user explicitly "suspends" a tab (close + save).
 * Deleted when a user restores the tab (opens URL locally + deletes row).
 */
const suspendedTabs = defineTable(
	type({
		id: 'string', // nanoid, generated on suspend
		url: 'string', // The tab URL
		title: 'string', // Tab title at time of suspend
		'favIconUrl?': 'string', // Favicon URL (nullable)
		pinned: 'boolean', // Whether tab was pinned
		sourceDeviceId: 'string', // Device that suspended this tab
		suspendedAt: 'number', // Timestamp (ms since epoch)
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// Composite ID Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Use this whenever you need to construct a {@link TabCompositeId} from its parts.
 * The resulting ID is branded to prevent accidental mixing with other ID types.
 *
 * @example
 * ```typescript
 * const id = createTabCompositeId(deviceId, 123);
 * // "abc123_123" as TabCompositeId
 *
 * tables.tabs.delete(createTabCompositeId(deviceId, tabId));
 * ```
 */
export function createTabCompositeId(
	deviceId: string,
	tabId: number,
): TabCompositeId {
	return `${deviceId}_${tabId}` as TabCompositeId;
}

/**
 * Create a device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Use this whenever you need to construct a {@link WindowCompositeId} from its parts.
 * The resulting ID is branded to prevent accidental mixing with other ID types.
 *
 * @example
 * ```typescript
 * const id = createWindowCompositeId(deviceId, 456);
 * // "abc123_456" as WindowCompositeId
 *
 * tables.windows.delete(createWindowCompositeId(deviceId, windowId));
 * ```
 */
export function createWindowCompositeId(
	deviceId: string,
	windowId: number,
): WindowCompositeId {
	return `${deviceId}_${windowId}` as WindowCompositeId;
}

/**
 * Create a device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Use this whenever you need to construct a {@link GroupCompositeId} from its parts.
 * The resulting ID is branded to prevent accidental mixing with other ID types.
 *
 * @example
 * ```typescript
 * const id = createGroupCompositeId(deviceId, 789);
 * // "abc123_789" as GroupCompositeId
 *
 * tables.tabGroups.delete(createGroupCompositeId(deviceId, groupId));
 * ```
 */
export function createGroupCompositeId(
	deviceId: string,
	groupId: number,
): GroupCompositeId {
	return `${deviceId}_${groupId}` as GroupCompositeId;
}

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
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const BROWSER_TABLES = {
	devices,
	tabs,
	windows,
	tabGroups,
	suspendedTabs,
};

// ─────────────────────────────────────────────────────────────────────────────
// Type Exports
// ─────────────────────────────────────────────────────────────────────────────

export type Device = InferTableRow<typeof BROWSER_TABLES.devices>;
export type Tab = InferTableRow<typeof BROWSER_TABLES.tabs>;
export type Window = InferTableRow<typeof BROWSER_TABLES.windows>;
export type TabGroup = InferTableRow<typeof BROWSER_TABLES.tabGroups>;
export type SuspendedTab = InferTableRow<typeof BROWSER_TABLES.suspendedTabs>;

export type BrowserTables = typeof BROWSER_TABLES;
