/**
 * Popup-side workspace client for accessing Y.Doc data.
 *
 * The popup needs direct access to the Y.Doc for the saved tabs table,
 * which is shared across devices via Yjs (not available through Chrome APIs).
 *
 * This creates a lightweight workspace client with IndexedDB persistence
 * and WebSocket sync — the same Y.Doc as the background service worker.
 * Both share the same workspace ID (`tab-manager`), so IndexedDB and
 * sync will converge on the same document.
 *
 * `.withActions()` attaches all AI-callable operations (tab search, close,
 * group, etc.) as workspace actions. `createActionContext()` derives these
 * into TanStack AI client tools, server definitions, and a label lookup.
 */

import { createActionContext } from '@epicenter/ai';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import Type from 'typebox';
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
import { getDeviceId } from '$lib/device/device-id';
import { definition } from '$lib/workspace';

/**
 * Popup workspace client.
 *
 * Provides typed access to all browser tables including saved tabs.
 * Shares the same Y.Doc as the background service worker via IndexedDB
 * persistence and sync. Actions are available at `.actions` for AI tool
 * derivation.
 */
export const popupWorkspace = createWorkspace(definition)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: 'ws://127.0.0.1:3913/rooms/{id}',
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

export const actionContext = createActionContext(popupWorkspace.actions, {
	labels: {
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
	},
});

export type PopupTools = typeof actionContext.tools;
export type PopupActionName = PopupTools[number]['name'];

// Set local awareness on connect
void popupWorkspace.whenReady.then(() => {
	popupWorkspace.awareness.setLocal({
		deviceId: 'popup',
		deviceType: 'browser-extension',
	});
});
