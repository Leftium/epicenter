/**
 * Workspace — schema, client, and actions for the tab manager.
 *
 * Contains table definitions for persistent data (saved tabs, bookmarks, chat,
 * devices, tool trust), branded ID types, the workspace client (single Y.Doc
 * instance with IndexedDB + WebSocket sync), and AI-callable actions.
 *
 * Live browser tab/window state is NOT stored here—Chrome is the sole authority
 * for ephemeral browser data. See {@link file://./state/browser-state.svelte.ts}.
 */

import { actionsToClientTools, toToolDefinitions } from '@epicenter/ai';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
	iterateActions,
} from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import { Ok, tryAsync } from 'wellcrafted/result';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { authState } from '$lib/state/auth.svelte';
import { serverUrl } from '$lib/state/settings.svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Branded device ID — nanoid generated once per browser installation.
 *
 * Prevents accidental mixing with other string IDs (conversation, tab, etc.).
 */
export type DeviceId = string & Brand<'DeviceId'>;
export const DeviceId = type('string').as<DeviceId>();

/**
 * Branded saved tab ID — nanoid generated when a tab is explicitly saved.
 *
 * Prevents accidental mixing with other string IDs.
 */
export type SavedTabId = Id & Brand<'SavedTabId'>;
export const SavedTabId = type('string').as<SavedTabId>();
/**
 * Generate a unique {@link SavedTabId} for a newly saved tab.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * workspaceClient.tables.savedTabs.set({
 *   id: generateSavedTabId(),
 *   url: tab.url,
 *   title: tab.title || 'Untitled',
 *   // …remaining fields
 * });
 * ```
 */
export const generateSavedTabId = (): SavedTabId => generateId() as SavedTabId;

/**
 * Branded bookmark ID — nanoid generated when a URL is bookmarked.
 *
 * Unlike {@link SavedTabId}, bookmarks persist indefinitely—opening a
 * bookmarked URL does NOT delete the record.
 */
export type BookmarkId = Id & Brand<'BookmarkId'>;
export const BookmarkId = type('string').as<BookmarkId>();
/**
 * Generate a unique {@link BookmarkId} for a newly created bookmark.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * workspaceClient.tables.bookmarks.set({
 *   id: generateBookmarkId(),
 *   url: tab.url,
 *   title: tab.title || 'Untitled',
 *   // …remaining fields
 * });
 * ```
 */
export const generateBookmarkId = (): BookmarkId => generateId() as BookmarkId;

/**
 * Branded conversation ID — nanoid generated when a chat conversation is created.
 *
 * Used as the primary key for conversations and as a foreign key in chat messages.
 * Prevents accidental mixing with message IDs or other string IDs.
 */
export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();
/**
 * Generate a unique {@link ConversationId} for a new chat conversation.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * const id = generateConversationId();
 * workspaceClient.tables.conversations.set({
 *   id,
 *   title: 'New Chat',
 *   provider: DEFAULT_PROVIDER,
 *   model: DEFAULT_MODEL,
 *   createdAt: Date.now(),
 *   updatedAt: Date.now(),
 *   // …remaining fields
 * });
 * ```
 */
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

/**
 * Branded chat message ID — nanoid generated when a message is created.
 *
 * Prevents accidental mixing with conversation IDs or other string IDs.
 */
export type ChatMessageId = Id & Brand<'ChatMessageId'>;
export const ChatMessageId = type('string').as<ChatMessageId>();
/**
 * Generate a unique {@link ChatMessageId} for a new chat message.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * const userMessageId = generateChatMessageId();
 * workspaceClient.tables.chatMessages.set({
 *   id: userMessageId,
 *   conversationId,
 *   role: 'user',
 *   parts: [{ type: 'text', content }],
 *   createdAt: Date.now(),
 *   // …remaining fields
 * });
 * ```
 */
export const generateChatMessageId = (): ChatMessageId =>
	generateId() as ChatMessageId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

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
 * Saved tabs — explicitly saved tabs that can be restored later.
 *
 * Unlike live browser tabs (which are ephemeral and Chrome-authoritative),
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
 * Tool trust — per-tool approval preferences for AI chat.
 *
 * Each row represents a user's trust decision for a specific destructive tool.
 * Tools not in this table default to 'ask' (show approval UI). Users can
 * escalate to 'always' (auto-approve) via the inline approval buttons.
 *
 * The `id` is the tool name (e.g. 'tabs_close') — the same string used
 * in action paths and tool definitions.
 */
const toolTrustTable = defineTable(
	type({
		id: 'string',
		trust: "'ask' | 'always'",
		_v: '1',
	}),
);
export type ToolTrust = InferTableRow<typeof toolTrustTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace client — single Y.Doc instance for the tab manager.
 *
 * Runs in the side panel context, which is a persistent extension page with
 * full Chrome API access and no dormancy. IndexedDB persistence and WebSocket
 * sync handle local storage and cross-device sync for persistent data (saved
 * tabs, bookmarks, chat, device identity, tool trust).
 *
 * Live browser tabs/windows are NOT in Y.Doc—Chrome is the sole authority.
 * Actions are available at `.actions` for AI tool derivation.
 */
export const workspaceClient = createWorkspace(
	defineWorkspace({
		id: 'epicenter.tab-manager',
		tables: {
			devices: devicesTable,
			savedTabs: savedTabsTable,
			bookmarks: bookmarksTable,
			conversations: conversationsTable,
			chatMessages: chatMessagesTable,
			toolTrust: toolTrustTable,
		},
	}),
)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => `${serverUrl.current}/workspaces/${docId}`,
			getToken: async () => authState.token,
		}),
	)
	.withActions(({ tables }) => ({
		tabs: {
			close: defineMutation({
				title: 'Close Tabs',
				description: 'Close one or more tabs by their native Chrome tab IDs.',
				input: Type.Object({
					tabIds: Type.Array(Type.Number()),
				}),
				handler: async ({ tabIds }) => {
					await tryAsync({
						try: () => browser.tabs.remove(tabIds),
						catch: () => Ok(undefined),
					});
					return { closedCount: tabIds.length };
				},
			}),

			open: defineMutation({
				title: 'Open Tab',
				description: 'Open a new tab with the given URL on the current device.',
				input: Type.Object({
					url: Type.String(),
				}),
				handler: async ({ url }) => {
					const { data: tab, error } = await tryAsync({
						try: () => browser.tabs.create({ url }),
						catch: () => Ok(undefined),
					});
					if (error || !tab) return { tabId: -1 };
					return { tabId: tab.id ?? -1 };
				},
			}),

			activate: defineMutation({
				title: 'Activate Tab',
				description:
					'Activate (focus) a specific tab by its native Chrome tab ID.',
				input: Type.Object({
					tabId: Type.Number(),
				}),
				handler: async ({ tabId }) => {
					const { error } = await tryAsync({
						try: () => browser.tabs.update(tabId, { active: true }),
						catch: () => Ok(undefined),
					});
					return { activated: !error };
				},
			}),

			save: defineMutation({
				title: 'Save Tabs',
				description: 'Save tabs for later. Optionally close them after saving.',
				input: Type.Object({
					tabIds: Type.Array(Type.Number()),
					close: Type.Optional(Type.Boolean()),
				}),
				handler: async ({ tabIds, close }) => {
					const deviceId = await getDeviceId();

					// Fetch all tabs in parallel
					const results = await Promise.allSettled(
						tabIds.map((id) => browser.tabs.get(id)),
					);

					const validTabs = results.flatMap((r) => {
						if (r.status !== 'fulfilled' || !r.value.url) return [];
						return [{ ...r.value, url: r.value.url }];
					});

					// Write to Y.Doc
					for (const tab of validTabs) {
						tables.savedTabs.set({
							id: generateSavedTabId(),
							url: tab.url,
							title: tab.title || 'Untitled',
							favIconUrl: tab.favIconUrl,
							pinned: tab.pinned ?? false,
							sourceDeviceId: deviceId,
							savedAt: Date.now(),
							_v: 1,
						});
					}

					// Batch close if requested
					if (close) {
						const idsToClose = validTabs
							.map((t) => t.id)
							.filter((id) => id !== undefined);
						await tryAsync({
							try: () => browser.tabs.remove(idsToClose),
							catch: () => Ok(undefined),
						});
					}

					return { savedCount: validTabs.length };
				},
			}),

			group: defineMutation({
				title: 'Group Tabs',
				description: 'Group tabs together with an optional title and color.',
				input: Type.Object({
					tabIds: Type.Array(Type.Number()),
					title: Type.Optional(Type.String()),
					color: Type.Optional(Type.String()),
				}),
				handler: async ({ tabIds, title, color }) => {
					const { data: groupId, error: groupError } = await tryAsync({
						try: () =>
							browser.tabs.group({
								tabIds: tabIds as [number, ...number[]],
							}),
						catch: () => Ok(undefined),
					});
					if (groupError || groupId === undefined) return { groupId: -1 };

					if (title || color) {
						const updateProps: Browser.tabGroups.UpdateProperties = {};
						if (title) updateProps.title = title;
						if (color)
							updateProps.color = color as `${Browser.tabGroups.Color}`;
						await tryAsync({
							try: () =>
								browser.tabGroups.update(groupId as number, updateProps),
							catch: () => Ok(undefined),
						});
					}

					return { groupId };
				},
			}),

			pin: defineMutation({
				title: 'Pin Tabs',
				description: 'Pin or unpin tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.Number()),
					pinned: Type.Boolean(),
				}),
				handler: async ({ tabIds, pinned }) => {
					const results = await Promise.allSettled(
						tabIds.map((id) => browser.tabs.update(id, { pinned })),
					);
					return {
						pinnedCount: results.filter((r) => r.status === 'fulfilled').length,
					};
				},
			}),

			mute: defineMutation({
				title: 'Mute Tabs',
				description: 'Mute or unmute tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.Number()),
					muted: Type.Boolean(),
				}),
				handler: async ({ tabIds, muted }) => {
					const results = await Promise.allSettled(
						tabIds.map((id) => browser.tabs.update(id, { muted })),
					);
					return {
						mutedCount: results.filter((r) => r.status === 'fulfilled').length,
					};
				},
			}),

			reload: defineMutation({
				title: 'Reload Tabs',
				description: 'Reload one or more tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.Number()),
				}),
				handler: async ({ tabIds }) => {
					const results = await Promise.allSettled(
						tabIds.map((id) => browser.tabs.reload(id)),
					);
					return {
						reloadedCount: results.filter((r) => r.status === 'fulfilled')
							.length,
					};
				},
			}),
		},

		devices: {
			list: defineQuery({
				title: 'List Devices',
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
	}));

export const workspaceTools = actionsToClientTools(workspaceClient.actions);
export const workspaceDefinitions = toToolDefinitions(workspaceTools);

export type WorkspaceTools = typeof workspaceTools;
export type WorkspaceActionName = WorkspaceTools[number]['name'];

/**
 * Lookup map from tool name to human-readable title.
 *
 * Used by `ToolCallPart.svelte` to display action titles instead of
 * deriving names from underscore-separated tool names.
 */
export const workspaceToolTitles: Record<string, string> = Object.fromEntries(
	[...iterateActions(workspaceClient.actions)]
		.filter(([action]) => action.title !== undefined)
		.map(([action, path]) => [path.join('_'), action.title!]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Device Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the current device in the Y.Doc devices table.
 *
 * Preserves any user-edited device name. Should be called once during app init
 * (e.g. in App.svelte's onMount) after the workspace client is ready.
 *
 * Saved tabs and bookmarks reference `sourceDeviceId`, so device registration
 * must run before any save/bookmark operations.
 *
 * @example
 * ```typescript
 * await workspaceClient.whenReady;
 * await registerDevice();
 * ```
 */
export async function registerDevice(): Promise<void> {
	const id = await getDeviceId();
	const existingDevice = workspaceClient.tables.devices.get(id);
	const existingName =
		existingDevice.status === 'valid' ? existingDevice.row.name : null;
	workspaceClient.tables.devices.set({
		id,
		name: existingName ?? (await generateDefaultDeviceName()),
		lastSeen: new Date().toISOString(),
		browser: getBrowserName(),
		_v: 1,
	});
}
