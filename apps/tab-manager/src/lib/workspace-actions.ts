/**
 * Workspace action factory for the tab manager.
 *
 * Defines all AI-callable operations as `defineQuery`/`defineMutation` actions
 * with TypeBox schemas. The factory receives the workspace client and closes
 * over Chrome APIs and device ID resolution.
 *
 * Read actions query Y.Doc tables directly via `client.tables`.
 * Mutation actions call through to the Chrome API wrappers in `commands/actions.ts`.
 */

import type { TablesHelper } from '@epicenter/hq';
import { defineMutation, defineQuery } from '@epicenter/hq';
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
import type { DeviceId } from '$lib/workspace';
import { definition } from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Device ID Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lazily resolve the device ID for mutation actions.
 *
 * Cached after first call. Needed to convert composite tab IDs
 * (e.g. `deviceId_123`) into native Chrome tab IDs for API calls.
 */
let cachedDeviceId: DeviceId | null = null;
async function resolveDeviceId(): Promise<DeviceId> {
	if (!cachedDeviceId) {
		cachedDeviceId = await getDeviceId();
	}
	return cachedDeviceId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create all tab manager actions.
 *
 * Pass to `.withActions()` on the workspace client:
 * ```typescript
 * const workspace = createWorkspace(definition)
 *   .withExtension(...)
 *   .withActions(createTabManagerActions);
 * ```
 */
type DefinitionTables = NonNullable<(typeof definition)['tables']>;

export function createTabManagerActions(client: {
	tables: TablesHelper<DefinitionTables>;
}) {
	const { tables } = client;

	return {
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
					const deviceId = await resolveDeviceId();
					return executeCloseTabs(tabIds, deviceId);
				},
			}),

			open: defineMutation({
				description:
					'Open a new tab with the given URL on the current device.',
				input: Type.Object({
					url: Type.String(),
					windowId: Type.Optional(Type.String()),
				}),
				handler: async ({ url, windowId }) => {
					return executeOpenTab(url, windowId);
				},
			}),

			activate: defineMutation({
				description:
					'Activate (focus) a specific tab by its composite ID.',
				input: Type.Object({
					tabId: Type.String(),
				}),
				handler: async ({ tabId }) => {
					const deviceId = await resolveDeviceId();
					return executeActivateTab(tabId, deviceId);
				},
			}),

			save: defineMutation({
				description:
					'Save tabs for later. Optionally close them after saving.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					close: Type.Optional(Type.Boolean()),
				}),
				handler: async ({ tabIds, close }) => {
					const deviceId = await resolveDeviceId();
					return executeSaveTabs(
						tabIds,
						close ?? false,
						deviceId,
						tables.savedTabs,
					);
				},
			}),

			group: defineMutation({
				description:
					'Group tabs together with an optional title and color.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					title: Type.Optional(Type.String()),
					color: Type.Optional(Type.String()),
				}),
				handler: async ({ tabIds, title, color }) => {
					const deviceId = await resolveDeviceId();
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
					const deviceId = await resolveDeviceId();
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
					const deviceId = await resolveDeviceId();
					return executeMuteTabs(tabIds, muted, deviceId);
				},
			}),

			reload: defineMutation({
				description: 'Reload one or more tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
				}),
				handler: async ({ tabIds }) => {
					const deviceId = await resolveDeviceId();
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
							tabCount: allTabs.filter((t) => t.windowId === w.id)
								.length,
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
	};
}
