/**
 * Workspace client — browser-specific wiring and AI-callable actions.
 *
 * Imports the schema from `schema.ts` and adds IndexedDB persistence,
 * BroadcastChannel sync, WebSocket sync, encryption, and action handlers
 * that call Chrome extension APIs.
 *
 * Live browser state (tabs, windows, tab groups) is NOT stored here—Chrome is
 * the sole authority for ephemeral browser state. See `browser-state.svelte.ts`.
 */

import { actionsToClientTools, toToolDefinitions } from '@epicenter/ai';
import { createAuth } from '@epicenter/svelte/auth';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
	iterateActions,
} from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import Type from 'typebox';
import { Ok, tryAsync } from 'wellcrafted/result';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import {
	authSession,
	getGoogleCredentials,
} from '$lib/state/auth';
import { userKeyCache } from '$lib/state/key-cache';
import { remoteServerUrl, serverUrl } from '$lib/state/settings.svelte';
import { definition, generateSavedTabId } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Singleton
// ─────────────────────────────────────────────────────────────────────────────

export const workspace = buildWorkspaceClient();
export const auth = createAuth({
	baseURL: () => remoteServerUrl.current,
	session: authSession,
	signInWithGoogle: getGoogleCredentials,
	onLogin(session) {
		workspace.unlockWithKey(session.userKeyBase64);
		workspace.extensions.sync.reconnect();
	},
	onLogout() {
		workspace.clearLocalData();
		workspace.extensions.sync.reconnect();
	},
});

export const workspaceTools = actionsToClientTools(workspace.actions);
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
	[...iterateActions(workspace.actions)]
		.filter(([action]) => action.title !== undefined)
		.map(([action, path]) => [path.join('_'), action.title!]),
);

/**
 * Register this browser installation as a device in the workspace.
 *
 * Upserts the device row—preserves existing name if present, otherwise
 * generates a default. Called once from App.svelte after workspace is ready.
 */
export async function registerDevice(): Promise<void> {
	await workspace.whenReady;
	const id = await getDeviceId();
	const existing = workspace.tables.devices.get(id);
	const existingName = existing.status === 'valid' ? existing.row.name : null;
	workspace.tables.devices.set({
		id,
		name: existingName ?? (await generateDefaultDeviceName()),
		lastSeen: new Date().toISOString(),
		browser: getBrowserName(),
		_v: 1,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation (hoisted — function declarations below are available above)
// ─────────────────────────────────────────────────────────────────────────────

function buildWorkspaceClient() {
	return createWorkspace(definition)
		.withEncryption({ userKeyCache })
		.withExtension('persistence', indexeddbPersistence)
		.withExtension('broadcast', broadcastChannelSync)
		.withExtension(
			'sync',
			createSyncExtension({
				url: (workspaceId) => `${serverUrl.current}/workspaces/${workspaceId}`,
				getToken: async () =>
					auth.session.status === 'authenticated'
						? auth.session.token
						: null,
			}),
		)
		.withActions(({ tables }) => ({
			tabs: {
				close: defineMutation({
					title: 'Close Tabs',
					description: 'Close one or more tabs by their IDs.',
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
					description:
						'Open a new tab with the given URL on the current device.',
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
					description: 'Activate (focus) a specific tab by its ID.',
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
					description:
						'Save tabs for later. Optionally close them after saving.',
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

						// Sync writes to Y.Doc
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

						return { groupId: groupId as number };
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
							pinnedCount: results.filter((r) => r.status === 'fulfilled')
								.length,
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
							mutedCount: results.filter((r) => r.status === 'fulfilled')
								.length,
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
}
