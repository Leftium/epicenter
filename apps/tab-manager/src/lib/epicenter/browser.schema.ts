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
	type Row,
	select,
	table,
	text,
} from '@epicenter/hq/dynamic';

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
// Table Definitions (Standard Array Format)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devices table - tracks browser installations for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID collisions.
 */
export const DEVICES_TABLE = table({
	id: 'devices',
	name: 'Devices',
	description: 'Browser installations for multi-device sync',
	icon: 'emoji:💻',
	fields: [
		id(), // NanoID, generated once on install
		text({ id: 'name' }), // User-editable: "Chrome on macOS", "Firefox on Windows"
		text({ id: 'last_seen' }), // ISO timestamp, updated on each sync
		text({ id: 'browser' }), // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
	],
});

/**
 * Tabs table - shadows browser tab state.
 *
 * The `id` field is a composite key: `${deviceId}_${tabId}`.
 * This prevents collisions when syncing across multiple devices.
 */
export const TABS_TABLE = table({
	id: 'tabs',
	name: 'Tabs',
	description: 'Browser tab state',
	icon: 'emoji:📑',
	fields: [
		id(), // Composite: `${deviceId}_${tabId}`
		text({ id: 'device_id' }), // Foreign key to devices table
		integer({ id: 'tab_id' }), // Original browser tab ID for API calls
		text({ id: 'window_id' }), // Composite: `${deviceId}_${windowId}`
		text({ id: 'url' }),
		text({ id: 'title' }),
		text({ id: 'fav_icon_url', nullable: true }),
		integer({ id: 'index' }), // Zero-based position in tab strip
		boolean({ id: 'pinned', default: false }),
		boolean({ id: 'active', default: false }),
		boolean({ id: 'highlighted', default: false }),
		boolean({ id: 'muted', default: false }),
		boolean({ id: 'audible', default: false }),
		boolean({ id: 'discarded', default: false }), // Tab unloaded to save memory
		boolean({ id: 'auto_discardable', default: true }),
		select({ id: 'status', options: TAB_STATUS, default: 'complete' }),
		text({ id: 'group_id', nullable: true }), // Chrome 88+, null on Firefox
		text({ id: 'opener_tab_id', nullable: true }), // ID of tab that opened this one
		boolean({ id: 'incognito', default: false }),
	],
});

/**
 * Windows table - shadows browser window state.
 *
 * The `id` field is a composite key: `${deviceId}_${windowId}`.
 */
export const WINDOWS_TABLE = table({
	id: 'windows',
	name: 'Windows',
	description: 'Browser window state',
	icon: 'emoji:🪟',
	fields: [
		id(), // Composite: `${deviceId}_${windowId}`
		text({ id: 'device_id' }), // Foreign key to devices table
		integer({ id: 'window_id' }), // Original browser window ID for API calls
		select({ id: 'state', options: WINDOW_STATES, default: 'normal' }),
		select({ id: 'type', options: WINDOW_TYPES, default: 'normal' }),
		boolean({ id: 'focused', default: false }),
		boolean({ id: 'always_on_top', default: false }),
		boolean({ id: 'incognito', default: false }),
		integer({ id: 'top', default: 0 }),
		integer({ id: 'left', default: 0 }),
		integer({ id: 'width', default: 800 }),
		integer({ id: 'height', default: 600 }),
	],
});

/**
 * Tab groups table - Chrome 88+ only, not supported on Firefox.
 *
 * The `id` field is a composite key: `${deviceId}_${groupId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups
 */
export const TAB_GROUPS_TABLE = table({
	id: 'tab_groups',
	name: 'Tab Groups',
	description: 'Chrome tab groups (Chrome 88+)',
	icon: 'emoji:📁',
	fields: [
		id(), // Composite: `${deviceId}_${groupId}`
		text({ id: 'device_id' }), // Foreign key to devices table
		integer({ id: 'group_id' }), // Original browser group ID for API calls
		text({ id: 'window_id' }), // Composite: `${deviceId}_${windowId}`
		text({ id: 'title', nullable: true }),
		select({ id: 'color', options: TAB_GROUP_COLORS, default: 'grey' }),
		boolean({ id: 'collapsed', default: false }),
	],
});

// ─────────────────────────────────────────────────────────────────────────────
// Type Exports
// ─────────────────────────────────────────────────────────────────────────────

export type Device = Row<(typeof DEVICES_TABLE)['fields']>;
export type Tab = Row<(typeof TABS_TABLE)['fields']>;
export type Window = Row<(typeof WINDOWS_TABLE)['fields']>;
export type TabGroup = Row<(typeof TAB_GROUPS_TABLE)['fields']>;

// Export table definitions for workspace composition
export const BROWSER_TABLES = [
	DEVICES_TABLE,
	TABS_TABLE,
	WINDOWS_TABLE,
	TAB_GROUPS_TABLE,
] as const;

export type BrowserTables = typeof BROWSER_TABLES;
