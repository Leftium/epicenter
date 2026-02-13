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
 * The `id` field is a composite key: `${deviceId}_${tabId}`.
 * This prevents collisions when syncing across multiple devices.
 */
const tabs = defineTable(
	type({
		id: 'string', // Composite: `${deviceId}_${tabId}`
		deviceId: 'string', // Foreign key to devices table
		tabId: 'number', // Original browser tab ID for API calls
		windowId: 'string', // Composite: `${deviceId}_${windowId}`
		url: 'string',
		title: 'string',
		'favIconUrl?': 'string', // Nullable
		index: 'number', // Zero-based position in tab strip
		pinned: 'boolean',
		active: 'boolean',
		highlighted: 'boolean',
		muted: 'boolean',
		audible: 'boolean',
		discarded: 'boolean', // Tab unloaded to save memory
		autoDiscardable: 'boolean',
		status: "'unloaded' | 'loading' | 'complete'",
		'groupId?': 'string', // Chrome 88+, null on Firefox
		'openerTabId?': 'string', // ID of tab that opened this one
		incognito: 'boolean',
	}),
);

/**
 * Windows table - shadows browser window state.
 *
 * The `id` field is a composite key: `${deviceId}_${windowId}`.
 */
const windows = defineTable(
	type({
		id: 'string', // Composite: `${deviceId}_${windowId}`
		deviceId: 'string', // Foreign key to devices table
		windowId: 'number', // Original browser window ID for API calls
		state:
			"'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen'",
		type: "'normal' | 'popup' | 'panel' | 'app' | 'devtools'",
		focused: 'boolean',
		alwaysOnTop: 'boolean',
		incognito: 'boolean',
		top: 'number',
		left: 'number',
		width: 'number',
		height: 'number',
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
		id: 'string', // Composite: `${deviceId}_${groupId}`
		deviceId: 'string', // Foreign key to devices table
		groupId: 'number', // Original browser group ID for API calls
		windowId: 'string', // Composite: `${deviceId}_${windowId}`
		'title?': 'string', // Nullable
		color:
			"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'",
		collapsed: 'boolean',
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
