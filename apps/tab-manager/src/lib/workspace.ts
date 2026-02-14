/**
 * Workspace definition — the single source of truth for the tab manager schema.
 *
 * Contains table definitions, the workspace definition, and all inferred types.
 * Both background and popup import from here; neither defines their own schema.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */

import {
	defineTable,
	defineWorkspace,
	type InferTableRow,
} from '@epicenter/hq/static';
import { type } from 'arktype';
import {
	GroupCompositeId,
	TabCompositeId,
	WindowCompositeId,
} from '$lib/device/composite-id';

/**
 * The workspace definition — shared by background and popup.
 *
 * Both call `createWorkspace(definition)` independently (each needs its own
 * Y.Doc instance), but the schema is defined exactly once here.
 */
export const definition = defineWorkspace({
	id: 'tab-manager',

	tables: {
		/**
		 * Devices table - tracks browser installations for multi-device sync.
		 *
		 * Each device generates a unique ID on first install, stored in storage.local.
		 * This enables syncing tabs across multiple computers while preventing ID collisions.
		 */
		devices: defineTable(
			type({
				id: 'string', // NanoID, generated once on install
				name: 'string', // User-editable: "Chrome on macOS", "Firefox on Windows"
				lastSeen: 'string', // ISO timestamp, updated on each sync
				browser: 'string', // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
			}),
		),

		/**
		 * Tabs table - shadows browser tab state.
		 *
		 * Near 1:1 mapping with `chrome.tabs.Tab`. Optional fields match Chrome's optionality.
		 * The `id` field is a composite key: `${deviceId}_${tabId}`.
		 * This prevents collisions when syncing across multiple devices.
		 *
		 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
		 */
		tabs: defineTable(
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
		),

		/**
		 * Windows table - shadows browser window state.
		 *
		 * Near 1:1 mapping with `chrome.windows.Window`. Optional fields match Chrome's optionality.
		 * The `id` field is a composite key: `${deviceId}_${windowId}`.
		 *
		 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
		 */
		windows: defineTable(
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
		),

		/**
		 * Tab groups table - Chrome 88+ only, not supported on Firefox.
		 *
		 * The `id` field is a composite key: `${deviceId}_${groupId}`.
		 *
		 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups
		 */
		tabGroups: defineTable(
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
		),

		/**
		 * Saved tabs table — explicitly saved tabs that can be restored later.
		 *
		 * Unlike the `tabs` table (which mirrors live browser state and is device-owned),
		 * saved tabs are shared across all devices. Any device can read, edit, or
		 * restore a saved tab.
		 *
		 * Created when a user explicitly saves a tab (close + persist).
		 * Deleted when a user restores the tab (opens URL locally + deletes row).
		 *
		 * NOTE: The key `suspendedTabs` and field `suspendedAt` are Y.Doc storage
		 * keys — do not rename without a data migration.
		 */
		suspendedTabs: defineTable(
			type({
				id: 'string', // nanoid, generated on save
				url: 'string', // The tab URL
				title: 'string', // Tab title at time of save
				'favIconUrl?': 'string', // Favicon URL (nullable)
				pinned: 'boolean', // Whether tab was pinned
				sourceDeviceId: 'string', // Device that saved this tab
				suspendedAt: 'number', // Timestamp (ms since epoch)
			}),
		),
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Type Exports
// ─────────────────────────────────────────────────────────────────────────────

type Tables = NonNullable<(typeof definition)['tables']>;

export type Device = InferTableRow<Tables['devices']>;
export type Tab = InferTableRow<Tables['tabs']>;
export type Window = InferTableRow<Tables['windows']>;
export type TabGroup = InferTableRow<Tables['tabGroups']>;
export type SavedTab = InferTableRow<Tables['suspendedTabs']>;
