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

import {
	boolean,
	id,
	integer,
	type SerializedRow,
	select,
	text,
} from '@epicenter/hq';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chrome window states
 * @see Browser.windows.WindowState
 * Note: 'locked-fullscreen' is ChromeOS only and requires allowlisted extensions
 */
export const WINDOW_STATES = [
	'normal',
	'minimized',
	'maximized',
	'fullscreen',
	'locked-fullscreen',
] as const;

/**
 * Chrome window types
 * @see Browser.windows.WindowType
 * Note: 'panel' and 'app' are deprecated Chrome App types
 */
export const WINDOW_TYPES = [
	'normal',
	'popup',
	'panel',
	'app',
	'devtools',
] as const;

/**
 * Chrome tab loading status
 * @see Browser.tabs.TabStatus
 */
export const TAB_STATUS = ['unloaded', 'loading', 'complete'] as const;

/**
 * Chrome tab group colors
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups#type-Color
 */
export const TAB_GROUP_COLORS = [
	'grey',
	'blue',
	'red',
	'yellow',
	'green',
	'pink',
	'purple',
	'cyan',
	'orange',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Table Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devices table - tracks browser installations for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID collisions.
 */
export const DEVICES_SCHEMA = {
	id: id(), // NanoID, generated once on install
	name: text(), // User-editable: "Chrome on macOS", "Firefox on Windows"
	last_seen: text(), // ISO timestamp, updated on each sync
	browser: text(), // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
} as const;

/**
 * Tabs table - shadows browser tab state.
 *
 * The `id` field is a composite key: `${deviceId}_${tabId}`.
 * This prevents collisions when syncing across multiple devices.
 */
export const TABS_SCHEMA = {
	id: id(), // Composite: `${deviceId}_${tabId}`
	device_id: text(), // Foreign key to devices table
	tab_id: integer(), // Original browser tab ID for API calls
	window_id: text(), // Composite: `${deviceId}_${windowId}`
	url: text(),
	title: text(),
	fav_icon_url: text({ nullable: true }),
	index: integer(), // Zero-based position in tab strip
	pinned: boolean({ default: false }),
	active: boolean({ default: false }),
	highlighted: boolean({ default: false }),
	muted: boolean({ default: false }),
	audible: boolean({ default: false }),
	discarded: boolean({ default: false }), // Tab unloaded to save memory
	auto_discardable: boolean({ default: true }),
	status: select({ options: TAB_STATUS, default: 'complete' }),
	group_id: text({ nullable: true }), // Chrome 88+, null on Firefox
	opener_tab_id: text({ nullable: true }), // ID of tab that opened this one
	incognito: boolean({ default: false }),
} as const;

/**
 * Windows table - shadows browser window state.
 *
 * The `id` field is a composite key: `${deviceId}_${windowId}`.
 */
export const WINDOWS_SCHEMA = {
	id: id(), // Composite: `${deviceId}_${windowId}`
	device_id: text(), // Foreign key to devices table
	window_id: integer(), // Original browser window ID for API calls
	state: select({ options: WINDOW_STATES, default: 'normal' }),
	type: select({ options: WINDOW_TYPES, default: 'normal' }),
	focused: boolean({ default: false }),
	always_on_top: boolean({ default: false }),
	incognito: boolean({ default: false }),
	top: integer({ default: 0 }),
	left: integer({ default: 0 }),
	width: integer({ default: 800 }),
	height: integer({ default: 600 }),
} as const;

/**
 * Tab groups table - Chrome 88+ only, not supported on Firefox.
 *
 * The `id` field is a composite key: `${deviceId}_${groupId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups
 */
export const TAB_GROUPS_SCHEMA = {
	id: id(), // Composite: `${deviceId}_${groupId}`
	device_id: text(), // Foreign key to devices table
	group_id: integer(), // Original browser group ID for API calls
	window_id: text(), // Composite: `${deviceId}_${windowId}`
	title: text({ nullable: true }),
	color: select({ options: TAB_GROUP_COLORS, default: 'grey' }),
	collapsed: boolean({ default: false }),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Type Exports
// ─────────────────────────────────────────────────────────────────────────────

export type Device = SerializedRow<typeof DEVICES_SCHEMA>;
export type Tab = SerializedRow<typeof TABS_SCHEMA>;
export type Window = SerializedRow<typeof WINDOWS_SCHEMA>;
export type TabGroup = SerializedRow<typeof TAB_GROUPS_SCHEMA>;
