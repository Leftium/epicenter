/**
 * Workspace — schema, client, and actions for the tab manager.
 *
 * Contains table definitions, branded ID types, composite ID helpers, the
 * workspace client (single Y.Doc instance with IndexedDB + WebSocket sync),
 * and all AI-callable actions. Everything lives in one file because there is
 * exactly one consumer of the schema: the side panel's `createWorkspace` call.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */

import { type ActionLabel, actionsToClientTools, toServerDefinitions } from '@epicenter/ai';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
	type InferTableRow,
} from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import {
	executeActivateTab,
	executeCloseTabs,
	executeGroupTabs,
	executeMuteTabs,
	executeOpenTab,
	executePinTabs,
	executeReloadTabs,
	executeSaveTabs,
} from '$lib/commands/actions';
import { startCommandConsumer } from '$lib/commands/consumer';
import { getDeviceId } from '$lib/device/device-id';
import { authState } from '$lib/state/auth.svelte';
import { serverUrl } from '$lib/state/settings.svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Chrome API Sentinel Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors `chrome.tabs.TAB_ID_NONE`.
 * Assigned to tabs that aren't browser tabs (e.g. devtools windows).
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#property-TAB_ID_NONE
 */
export const TAB_ID_NONE = -1;

/**
 * Mirrors `chrome.tabGroups.TAB_GROUP_ID_NONE`.
 * Assigned to `Tab.groupId` when the tab doesn't belong to any group.
 *
 * Note: `TabGroup.id` itself is guaranteed to never be this value —
 * only `Tab.groupId` uses it as a sentinel.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups#property-TAB_GROUP_ID_NONE
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups/TabGroup
 */
export const TAB_GROUP_ID_NONE = -1;

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Branded device ID — nanoid generated once per browser installation.
 *
 * Prevents accidental mixing with other string IDs (conversation, tab, etc.).
 */
export type DeviceId = string & Brand<'DeviceId'>;
export const DeviceId = type('string').pipe((s): DeviceId => s as DeviceId);

/**
 * Branded saved tab ID — nanoid generated when a tab is explicitly saved.
 *
 * Prevents accidental mixing with composite tab IDs or other string IDs.
 */
export type SavedTabId = string & Brand<'SavedTabId'>;
export const SavedTabId = type('string').pipe(
	(s): SavedTabId => s as SavedTabId,
);

/**
 * Branded bookmark ID — nanoid generated when a URL is bookmarked.
 *
 * Unlike {@link SavedTabId}, bookmarks persist indefinitely—opening a
 * bookmarked URL does NOT delete the record.
 */
export type BookmarkId = string & Brand<'BookmarkId'>;
export const BookmarkId = type('string').pipe(
	(s): BookmarkId => s as BookmarkId,
);

/**
 * Branded conversation ID — nanoid generated when a chat conversation is created.
 *
 * Used as the primary key for conversations and as a foreign key in chat messages.
 * Prevents accidental mixing with message IDs or other string IDs.
 */
export type ConversationId = string & Brand<'ConversationId'>;
export const ConversationId = type('string').pipe(
	(s): ConversationId => s as ConversationId,
);

/**
 * Branded chat message ID — nanoid generated when a message is created.
 *
 * Prevents accidental mixing with conversation IDs or other string IDs.
 */
export type ChatMessageId = string & Brand<'ChatMessageId'>;
export const ChatMessageId = type('string').pipe(
	(s): ChatMessageId => s as ChatMessageId,
);

/**
 * Branded command ID — nanoid generated when an AI tool writes a command.
 *
 * Prevents accidental mixing with other string IDs (tab, conversation, etc.).
 */
export type CommandId = string & Brand<'CommandId'>;
export const CommandId = type('string').pipe((s): CommandId => s as CommandId);

// ─────────────────────────────────────────────────────────────────────────────
// Composite ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Prevents accidental mixing with plain strings, window IDs, or group IDs.
 */
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export const TabCompositeId = type('string').pipe(
	(s): TabCompositeId => s as TabCompositeId,
);

/**
 * Device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or group IDs.
 */
export type WindowCompositeId = string & Brand<'WindowCompositeId'>;
export const WindowCompositeId = type('string').pipe(
	(s): WindowCompositeId => s as WindowCompositeId,
);

/**
 * Device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or window IDs.
 */
export type GroupCompositeId = string & Brand<'GroupCompositeId'>;
export const GroupCompositeId = type('string').pipe(
	(s): GroupCompositeId => s as GroupCompositeId,
);

/**
 * Create a device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Callers must guard against `TAB_ID_NONE` (`-1`) and `undefined`
 * before calling — this function always returns a valid composite ID.
 *
 * Note: `openerTabId` is simply absent/undefined when no opener exists
 * (it never uses `-1` as a sentinel), so the caller only needs an
 * `undefined` check for that field.
 */
export function createTabCompositeId(
	deviceId: DeviceId,
	tabId: number,
): TabCompositeId {
	return `${deviceId}_${tabId}` as TabCompositeId;
}

/**
 * Create a device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Note: `WINDOW_ID_NONE` (`-1`) only appears in `windows.onFocusChanged`
 * events when all windows lose focus — it never appears on `Tab.windowId`.
 * If used with a focus event's windowId, the resulting composite ID is safe
 * for comparisons but should not be stored as a real window reference.
 */
export function createWindowCompositeId(
	deviceId: DeviceId,
	windowId: number,
): WindowCompositeId {
	return `${deviceId}_${windowId}` as WindowCompositeId;
}

/**
 * Create a device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Returns `undefined` when `groupId` is `TAB_GROUP_ID_NONE` (`-1`),
 * which Chrome uses for tabs that don't belong to any group.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups#property-TAB_GROUP_ID_NONE
 */
export function createGroupCompositeId(
	deviceId: DeviceId,
	groupId: number,
): GroupCompositeId | undefined {
	if (groupId === TAB_GROUP_ID_NONE) return undefined;
	return `${deviceId}_${groupId}` as GroupCompositeId;
}

/**
 * Internal helper to parse a composite ID.
 */
function parseCompositeIdInternal(
	compositeId: string,
): { deviceId: DeviceId; nativeId: number } | null {
	const idx = compositeId.indexOf('_');
	if (idx === -1) return null;

	const deviceId = compositeId.slice(0, idx) as DeviceId;
	const nativeId = Number.parseInt(compositeId.slice(idx + 1), 10);

	if (Number.isNaN(nativeId)) return null;

	return { deviceId, nativeId };
}

/**
 * Parse a composite tab ID into its parts.
 */
export function parseTabId(
	compositeId: TabCompositeId,
): { deviceId: DeviceId; tabId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, tabId: result.nativeId };
}

/**
 * Parse a composite window ID into its parts.
 */
export function parseWindowId(
	compositeId: WindowCompositeId,
): { deviceId: DeviceId; windowId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, windowId: result.nativeId };
}

/**
 * Parse a composite group ID into its parts.
 */
export function parseGroupId(
	compositeId: GroupCompositeId,
): { deviceId: DeviceId; groupId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, groupId: result.nativeId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

// ─── Shared types ─────────────────────────────────────────────────────────

const tabGroupColor = type(
	"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'",
);

const commandBase = type({
	id: CommandId,
	deviceId: DeviceId,
	createdAt: 'number',
	_v: '1',
});

// ─── Tables ──────────────────────────────────────────────────────────────────

/**
 * Devices — tracks browser installations for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID collisions.
 */
const devicesTable = defineTable(
	type({
		id: DeviceId, // NanoID, generated once on install
		name: 'string', // User-editable: "Chrome on macOS", "Firefox on Windows"
		lastSeen: 'string', // ISO timestamp, updated on each sync
		browser: 'string', // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
		_v: '1',
	}),
);
export type Device = InferTableRow<typeof devicesTable>;

/**
 * Tabs — shadows browser tab state.
 *
 * Near 1:1 mapping with `chrome.tabs.Tab`. Optional fields match Chrome's optionality.
 * The `id` field is a composite key: `${deviceId}_${tabId}`.
 * This prevents collisions when syncing across multiple devices.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 */
const tabsTable = defineTable(
	type({
		id: TabCompositeId, // Composite: `${deviceId}_${tabId}`
		deviceId: DeviceId, // Foreign key to devices table
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
		// Unioned with `undefined` so that present-but-undefined keys pass
		// arktype validation (which defaults to exactOptionalPropertyTypes).
		'url?': 'string | undefined',
		'title?': 'string | undefined',
		'favIconUrl?': 'string | undefined',
		'pendingUrl?': 'string | undefined', // Chrome 79+, URL before commit
		'status?': "'unloaded' | 'loading' | 'complete' | undefined",
		'audible?': 'boolean | undefined', // Chrome 45+
		/** @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-MutedInfo */
		'mutedInfo?': type({
			/** Whether the tab is muted (prevented from playing sound). The tab may be muted even if it has not played or is not currently playing sound. Equivalent to whether the 'muted' audio indicator is showing. */
			muted: 'boolean',
			/** The reason the tab was muted or unmuted. Not set if the tab's mute state has never been changed. */
			'reason?': "'user' | 'capture' | 'extension' | undefined",
			/** The ID of the extension that changed the muted state. Not set if an extension was not the reason the muted state last changed. */
			'extensionId?': 'string | undefined',
		}).or('undefined'),
		'groupId?': GroupCompositeId.or('undefined'), // Composite: `${deviceId}_${groupId}`, Chrome 88+
		'openerTabId?': TabCompositeId.or('undefined'), // Composite: `${deviceId}_${openerTabId}`
		'lastAccessed?': 'number | undefined', // Chrome 121+, ms since epoch
		'height?': 'number | undefined',
		'width?': 'number | undefined',
		'sessionId?': 'string | undefined', // From chrome.sessions API
		_v: '1',
	}),
);
export type Tab = InferTableRow<typeof tabsTable>;

/**
 * Windows — shadows browser window state.
 *
 * Near 1:1 mapping with `chrome.windows.Window`. Optional fields match Chrome's optionality.
 * The `id` field is a composite key: `${deviceId}_${windowId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */
const windowsTable = defineTable(
	type({
		id: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		deviceId: DeviceId, // Foreign key to devices table
		windowId: 'number', // Original browser window ID for API calls
		focused: 'boolean',
		alwaysOnTop: 'boolean',
		incognito: 'boolean',
		// Optional fields — matching chrome.windows.Window optionality
		'state?':
			"'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen' | undefined",
		'type?': "'normal' | 'popup' | 'panel' | 'app' | 'devtools' | undefined",
		'top?': 'number | undefined',
		'left?': 'number | undefined',
		'width?': 'number | undefined',
		'height?': 'number | undefined',
		'sessionId?': 'string | undefined', // From chrome.sessions API
		_v: '1',
	}),
);
export type Window = InferTableRow<typeof windowsTable>;

/**
 * Tab groups — Chrome 88+ only, not supported on Firefox.
 *
 * The `id` field is a composite key: `${deviceId}_${groupId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups
 */
const tabGroupsTable = defineTable(
	type({
		id: GroupCompositeId, // Composite: `${deviceId}_${groupId}`
		deviceId: DeviceId, // Foreign key to devices table
		groupId: 'number', // Original browser group ID for API calls
		windowId: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		collapsed: 'boolean',
		color: tabGroupColor,
		shared: 'boolean', // Chrome 137+
		// Optional fields — matching chrome.tabGroups.TabGroup optionality
		'title?': 'string | undefined',
		_v: '1',
	}),
);
export type TabGroup = InferTableRow<typeof tabGroupsTable>;

/**
 * Saved tabs — explicitly saved tabs that can be restored later.
 *
 * Unlike the `tabs` table (which mirrors live browser state and is device-owned),
 * saved tabs are shared across all devices. Any device can read, edit, or
 * restore a saved tab.
 *
 * Created when a user explicitly saves a tab (close + persist).
 * Deleted when a user restores the tab (opens URL locally + deletes row).
 */
const savedTabsTable = defineTable(
	type({
		id: SavedTabId, // nanoid, generated on save
		url: 'string', // The tab URL
		title: 'string', // Tab title at time of save
		'favIconUrl?': 'string | undefined', // Favicon URL (nullable)
		pinned: 'boolean', // Whether tab was pinned
		sourceDeviceId: DeviceId, // Device that saved this tab
		savedAt: 'number', // Timestamp (ms since epoch)
		_v: '1',
	}),
);
export type SavedTab = InferTableRow<typeof savedTabsTable>;

/**
 * Bookmarks — permanent, non-consumable URL references.
 *
 * Unlike saved tabs (which are deleted on restore), bookmarks persist
 * indefinitely. Opening a bookmark creates a new browser tab but does NOT
 * delete the record. Synced across devices via Y.Doc CRDT.
 */
const bookmarksTable = defineTable(
	type({
		id: BookmarkId, // nanoid, generated on bookmark
		url: 'string', // The bookmarked URL
		title: 'string', // Title at time of bookmark
		'favIconUrl?': 'string | undefined', // Favicon URL (nullable)
		'description?': 'string | undefined', // Optional user note
		sourceDeviceId: DeviceId, // Device that created the bookmark
		createdAt: 'number', // Timestamp (ms since epoch)
		_v: '1',
	}),
);
export type Bookmark = InferTableRow<typeof bookmarksTable>;

/**
 * AI conversations — metadata for each chat thread.
 *
 * Each conversation has its own message history (linked via
 * chatMessages.conversationId). Subpages use `parentId` to form
 * a tree — e.g. a deep research thread spawned from a specific
 * message in a parent conversation.
 */
const conversationsTable = defineTable(
	type({
		id: ConversationId,
		title: 'string',
		'parentId?': ConversationId.or('undefined'),
		'sourceMessageId?': ChatMessageId.or('undefined'),
		'systemPrompt?': 'string | undefined',
		provider: 'string',
		model: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

/**
 * Chat messages — TanStack AI UIMessage data persisted per conversation.
 *
 * The `parts` field stores MessagePart[] as a native array (no JSON
 * serialization). Runtime validation is skipped for parts because
 * they are always produced by TanStack AI — compile-time drift
 * detection in `ui-message.ts` catches type mismatches on
 * TanStack AI upgrades instead.
 *
 * @see {@link file://./ai/ui-message.ts} — drift detection + toUiMessage boundary
 */
const chatMessagesTable = defineTable(
	type({
		id: ChatMessageId,
		conversationId: ConversationId,
		role: "'user' | 'assistant' | 'system'",
		parts: type({} as type.cast<JsonValue[]>),
		createdAt: 'number',
		_v: '1',
	}),
);
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

/**
 * AI command queue — discriminated union on `action`.
 *
 * The server writes commands targeting a device; the device's background
 * worker observes, executes the Chrome API action, and writes the result.
 * `result?` presence = status: no result = pending, has result = done.
 *
 * Uses `commandBase.merge(type.or(...))` for a flat list of 8 action variants.
 *
 * @see specs/20260223T200500-ai-tools-command-queue.md
 */
const commandsTable = defineTable(
	commandBase.merge(
		type.or(
			{
				action: "'closeTabs'",
				tabIds: 'string[]',
				'result?': type({ closedCount: 'number' }).or('undefined'),
			},
			{
				action: "'openTab'",
				url: 'string',
				'windowId?': 'string',
				'result?': type({ tabId: 'string' }).or('undefined'),
			},
			{
				action: "'activateTab'",
				tabId: 'string',
				'result?': type({ activated: 'boolean' }).or('undefined'),
			},
			{
				action: "'saveTabs'",
				tabIds: 'string[]',
				close: 'boolean',
				'result?': type({ savedCount: 'number' }).or('undefined'),
			},
			{
				action: "'groupTabs'",
				tabIds: 'string[]',
				'title?': 'string',
				'color?': tabGroupColor,
				'result?': type({ groupId: 'string' }).or('undefined'),
			},
			{
				action: "'pinTabs'",
				tabIds: 'string[]',
				pinned: 'boolean',
				'result?': type({ pinnedCount: 'number' }).or('undefined'),
			},
			{
				action: "'muteTabs'",
				tabIds: 'string[]',
				muted: 'boolean',
				'result?': type({ mutedCount: 'number' }).or('undefined'),
			},
			{
				action: "'reloadTabs'",
				tabIds: 'string[]',
				'result?': type({ reloadedCount: 'number' }).or('undefined'),
			},
		),
	),
);
export type Command = InferTableRow<typeof commandsTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace client — single Y.Doc instance for the tab manager.
 *
 * Runs in the side panel context, which is a persistent extension page with
 * full Chrome API access and no dormancy. IndexedDB persistence and WebSocket
 * sync handle local storage and cross-device sync. Actions are available at
 * `.actions` for AI tool derivation.
 */
export const workspaceClient = createWorkspace(
	defineWorkspace({
		id: 'tab-manager',

		awareness: {
			deviceId: type('string'),
			deviceType: type('"browser-extension" | "desktop" | "server" | "cli"'),
		},

		tables: {
			devices: devicesTable,
			tabs: tabsTable,
			windows: windowsTable,
			tabGroups: tabGroupsTable,
			savedTabs: savedTabsTable,
			bookmarks: bookmarksTable,
			conversations: conversationsTable,
			chatMessages: chatMessagesTable,
			commands: commandsTable,
		},
	}),
)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${serverUrl.current}/workspaces/${workspaceId}`,
			getToken: async () => authState.token,
		}),
	)
	.withActions(({ tables }) => ({
		tabs: {
			search: defineQuery({
				description:
					'Search tabs by URL or title match. Returns matching tabs across all devices, optionally scoped to one device.',
				input: Type.Object({
					query: Type.String(),
					deviceId: Type.Optional(Type.String()),
				}),
				handler: ({ query, deviceId }) => {
					const lower = query.toLowerCase();
					const matched = tables.tabs.filter((tab) => {
						if (deviceId && tab.deviceId !== deviceId) return false;
						const title = tab.title?.toLowerCase() ?? '';
						const url = tab.url?.toLowerCase() ?? '';
						return title.includes(lower) || url.includes(lower);
					});
					return {
						results: matched.map((tab) => ({
							id: tab.id,
							deviceId: tab.deviceId,
							windowId: tab.windowId,
							title: tab.title ?? '(untitled)',
							url: tab.url ?? '',
							active: tab.active,
							pinned: tab.pinned,
						})),
					};
				},
			}),

			list: defineQuery({
				description:
					'List all open tabs. Optionally filter by device or window.',
				input: Type.Object({
					deviceId: Type.Optional(Type.String()),
					windowId: Type.Optional(Type.String()),
				}),
				handler: ({ deviceId, windowId }) => {
					const matched = tables.tabs.filter((tab) => {
						if (deviceId && tab.deviceId !== deviceId) return false;
						if (windowId && tab.windowId !== windowId) return false;
						return true;
					});
					return {
						tabs: matched.map((tab) => ({
							id: tab.id,
							deviceId: tab.deviceId,
							windowId: tab.windowId,
							title: tab.title ?? '(untitled)',
							url: tab.url ?? '',
							active: tab.active,
							pinned: tab.pinned,
							audible: tab.audible ?? false,
							muted: tab.mutedInfo?.muted ?? false,
							groupId: tab.groupId ?? null,
						})),
					};
				},
			}),

			close: defineMutation({
				description: 'Close one or more tabs by their composite IDs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
				}),
				handler: async ({ tabIds }) => {
					const deviceId = await getDeviceId();
					return executeCloseTabs(tabIds, deviceId);
				},
			}),

			open: defineMutation({
				description: 'Open a new tab with the given URL on the current device.',
				input: Type.Object({
					url: Type.String(),
					windowId: Type.Optional(Type.String()),
				}),
				handler: async ({ url, windowId }) => {
					return executeOpenTab(url, windowId);
				},
			}),

			activate: defineMutation({
				description: 'Activate (focus) a specific tab by its composite ID.',
				input: Type.Object({
					tabId: Type.String(),
				}),
				handler: async ({ tabId }) => {
					const deviceId = await getDeviceId();
					return executeActivateTab(tabId, deviceId);
				},
			}),

			save: defineMutation({
				description: 'Save tabs for later. Optionally close them after saving.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					close: Type.Optional(Type.Boolean()),
				}),
				handler: async ({ tabIds, close }) => {
					const deviceId = await getDeviceId();
					return executeSaveTabs(
						tabIds,
						close ?? false,
						deviceId,
						tables.savedTabs,
					);
				},
			}),

			group: defineMutation({
				description: 'Group tabs together with an optional title and color.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					title: Type.Optional(Type.String()),
					color: Type.Optional(Type.String()),
				}),
				handler: async ({ tabIds, title, color }) => {
					const deviceId = await getDeviceId();
					return executeGroupTabs(tabIds, deviceId, title, color);
				},
			}),

			pin: defineMutation({
				description: 'Pin or unpin tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					pinned: Type.Boolean(),
				}),
				handler: async ({ tabIds, pinned }) => {
					const deviceId = await getDeviceId();
					return executePinTabs(tabIds, pinned, deviceId);
				},
			}),

			mute: defineMutation({
				description: 'Mute or unmute tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					muted: Type.Boolean(),
				}),
				handler: async ({ tabIds, muted }) => {
					const deviceId = await getDeviceId();
					return executeMuteTabs(tabIds, muted, deviceId);
				},
			}),

			reload: defineMutation({
				description: 'Reload one or more tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
				}),
				handler: async ({ tabIds }) => {
					const deviceId = await getDeviceId();
					return executeReloadTabs(tabIds, deviceId);
				},
			}),
		},

		windows: {
			list: defineQuery({
				description:
					'List all browser windows with their tab counts. Optionally filter by device.',
				input: Type.Object({
					deviceId: Type.Optional(Type.String()),
				}),
				handler: ({ deviceId }) => {
					const windows = tables.windows.filter((w) => {
						if (deviceId && w.deviceId !== deviceId) return false;
						return true;
					});
					const allTabs = tables.tabs.getAllValid();
					return {
						windows: windows.map((w) => ({
							id: w.id,
							deviceId: w.deviceId,
							focused: w.focused,
							state: w.state ?? 'normal',
							type: w.type ?? 'normal',
							tabCount: allTabs.filter((t) => t.windowId === w.id).length,
						})),
					};
				},
			}),
		},

		devices: {
			list: defineQuery({
				description:
					'List all synced devices with their names, browsers, and online status.',
				input: Type.Object({}),
				handler: () => {
					const devices = tables.devices.getAllValid();
					return {
						devices: devices.map((d) => ({
							id: d.id,
							name: d.name,
							browser: d.browser,
							lastSeen: d.lastSeen,
						})),
					};
				},
			}),
		},

		domains: {
			count: defineQuery({
				description:
					'Count open tabs grouped by domain (e.g. youtube.com: 5, github.com: 3). Optionally filter by device.',
				input: Type.Object({
					deviceId: Type.Optional(Type.String()),
				}),
				handler: ({ deviceId }) => {
					const matched = tables.tabs.filter((tab) => {
						if (deviceId && tab.deviceId !== deviceId) return false;
						return true;
					});
					const counts = new Map<string, number>();
					for (const tab of matched) {
						if (!tab.url) continue;
						try {
							const domain = new URL(tab.url).hostname;
							counts.set(domain, (counts.get(domain) ?? 0) + 1);
						} catch {
							// Skip tabs with invalid URLs (e.g. chrome:// pages)
						}
					}
					const domains = Array.from(counts.entries())
						.map(([domain, count]) => ({ domain, count }))
						.sort((a, b) => b.count - a.count);
					return { domains };
				},
			}),
		},
	}));

export const workspaceTools = actionsToClientTools(workspaceClient.actions);
export const workspaceDefinitions = toServerDefinitions(workspaceTools);

export type WorkspaceTools = typeof workspaceTools;
export type WorkspaceActionName = WorkspaceTools[number]['name'];

/** Exhaustive map of action name → display labels for active/completed states. */
export const workspaceLabels: Record<WorkspaceActionName, ActionLabel> = {
	tabs_search: { active: 'Searching tabs', done: 'Searched tabs' },
	tabs_list: { active: 'Listing tabs', done: 'Listed tabs' },
	windows_list: { active: 'Listing windows', done: 'Listed windows' },
	devices_list: { active: 'Listing devices', done: 'Listed devices' },
	domains_count: {
		active: 'Counting domains',
		done: 'Counted domains',
	},
	tabs_close: { active: 'Closing tabs', done: 'Closed tabs' },
	tabs_open: { active: 'Opening tab', done: 'Opened tab' },
	tabs_activate: { active: 'Activating tab', done: 'Activated tab' },
	tabs_save: { active: 'Saving tabs', done: 'Saved tabs' },
	tabs_group: { active: 'Grouping tabs', done: 'Grouped tabs' },
	tabs_pin: { active: 'Pinning tabs', done: 'Pinned tabs' },
	tabs_mute: { active: 'Muting tabs', done: 'Muted tabs' },
	tabs_reload: { active: 'Reloading tabs', done: 'Reloaded tabs' },
};

/**
 * Reconnect the sync extension with fresh auth credentials.
 *
 * Call after sign-in so the WebSocket reconnects with a valid token,
 * or after sign-out to disconnect.
 */
export function reconnectSync() {
	workspaceClient.extensions.sync.reconnect();
}

// Initialize workspace: set awareness + start command consumer
void workspaceClient.whenReady.then(async () => {
	const deviceId = await getDeviceId();
	workspaceClient.awareness.setLocal({
		deviceId,
		deviceType: 'browser-extension',
	});

	// Start consuming AI commands targeting this device
	startCommandConsumer(
		workspaceClient.tables.commands,
		workspaceClient.tables.savedTabs,
		deviceId,
	);
});
