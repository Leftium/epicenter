/**
 * Client-side tool implementations for the sidebar.
 *
 * Read tools query the Y.Doc tables directly via `popupWorkspace`.
 * Mutation tools call Chrome `browser.*` APIs directly — the sidebar
 * (side panel) has full Chrome API access.
 *
 * Each definition's `.client(execute)` produces a `ClientTool` that
 * `ChatClient` auto-executes when the LLM calls it.
 */

import { clientTools } from '@tanstack/ai-client';
import { getDeviceId } from '$lib/device/device-id';
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
import type { DeviceId } from '$lib/workspace';
import { popupWorkspace } from '$lib/workspace-popup';
import {
	activateTabDef,
	closeTabsDef,
	countByDomainDef,
	groupTabsDef,
	listDevicesDef,
	listTabsDef,
	listWindowsDef,
	muteTabsDef,
	openTabDef,
	pinTabsDef,
	reloadTabsDef,
	saveTabsDef,
	searchTabsDef,
} from './definitions';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const tables = popupWorkspace.tables;

/**
 * Lazily resolve the device ID for mutation tools.
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
// Client Tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All client tools with execute functions, ready for `createChat({ tools })`.
 *
 * Read tools query Y.Doc tables directly.
 * Mutation tools call Chrome APIs via the shared action functions.
 *
 * @example
 * ```typescript
 * const chat = createChat({
 *   tools: tabManagerClientTools,
 *   connection: fetchServerSentEvents('/ai/chat'),
 * });
 * ```
 */
export const tabManagerClientTools = clientTools(
	// ── Read Tools ──────────────────────────────────────────────────────

	searchTabsDef.client(async ({ query, deviceId }) => {
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
	}),

	listTabsDef.client(async ({ deviceId, windowId }) => {
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
	}),

	listWindowsDef.client(async ({ deviceId }) => {
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
	}),

	listDevicesDef.client(async () => {
		const devices = tables.devices.getAllValid();
		return {
			devices: devices.map((d) => ({
				id: d.id,
				name: d.name,
				browser: d.browser,
				lastSeen: d.lastSeen,
			})),
		};
	}),

	countByDomainDef.client(async ({ deviceId }) => {
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
	}),

	// ── Mutation Tools ───────────────────────────────────────────────────

	closeTabsDef.client(async ({ tabIds }) => {
		const deviceId = await resolveDeviceId();
		return executeCloseTabs(tabIds, deviceId);
	}),

	openTabDef.client(async ({ url, windowId }) => {
		return executeOpenTab(url, windowId);
	}),

	activateTabDef.client(async ({ tabId }) => {
		const deviceId = await resolveDeviceId();
		return executeActivateTab(tabId, deviceId);
	}),

	saveTabsDef.client(async ({ tabIds, close }) => {
		const deviceId = await resolveDeviceId();
		return executeSaveTabs(
			tabIds,
			close ?? false,
			deviceId,
			tables.savedTabs,
		);
	}),

	groupTabsDef.client(async ({ tabIds, title, color }) => {
		const deviceId = await resolveDeviceId();
		return executeGroupTabs(tabIds, deviceId, title, color);
	}),

	pinTabsDef.client(async ({ tabIds, pinned }) => {
		const deviceId = await resolveDeviceId();
		return executePinTabs(tabIds, pinned, deviceId);
	}),

	muteTabsDef.client(async ({ tabIds, muted }) => {
		const deviceId = await resolveDeviceId();
		return executeMuteTabs(tabIds, muted, deviceId);
	}),

	reloadTabsDef.client(async ({ tabIds }) => {
		const deviceId = await resolveDeviceId();
		return executeReloadTabs(tabIds, deviceId);
	}),
);
