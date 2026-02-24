/**
 * BGSW read tool implementations.
 *
 * Each tool queries the tab-manager Y.Doc tables directly. Runs in the
 * background service worker where the authoritative Y.Doc lives — same
 * data as the server had, but without the WebSocket round-trip.
 *
 * These are near-identical to the server's read-tools.ts, except they
 * receive pre-bound table helpers instead of creating them from a raw Y.Doc.
 */

import type { TableHelper } from '@epicenter/hq';
import type { Device, Tab, Window } from '$lib/workspace';
import {
	countByDomainDef,
	listDevicesDef,
	listTabsDef,
	listWindowsDef,
	searchTabsDef,
} from './definitions';

/**
 * Table helpers required by read tools.
 *
 * Accepts the subset of workspace tables that read tools query.
 * Passed from the BGSW's workspace client — no raw Y.Doc needed.
 */
export type ReadToolTables = {
	tabs: TableHelper<Tab>;
	windows: TableHelper<Window>;
	devices: TableHelper<Device>;
};

/**
 * Create BGSW read tools bound to workspace table helpers.
 *
 * Each tool queries tables directly — no Chrome APIs needed, no command
 * queue. The BGSW has the authoritative Y.Doc with all synced devices' data.
 *
 * @param tables - The workspace client's table helpers
 * @returns Array of server tools ready for `chat({ tools })`
 */
export function createReadTools(tables: ReadToolTables) {
	return [
		searchTabsDef.server(async ({ query, deviceId }) => {
			const lower = query.toLowerCase();
			const tabs = tables.tabs.filter((tab) => {
				if (deviceId && tab.deviceId !== deviceId) return false;
				const title = tab.title?.toLowerCase() ?? '';
				const url = tab.url?.toLowerCase() ?? '';
				return title.includes(lower) || url.includes(lower);
			});
			return {
				results: tabs.map((tab) => ({
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

		listTabsDef.server(async ({ deviceId, windowId }) => {
			const tabs = tables.tabs.filter((tab) => {
				if (deviceId && tab.deviceId !== deviceId) return false;
				if (windowId && tab.windowId !== windowId) return false;
				return true;
			});
			return {
				tabs: tabs.map((tab) => ({
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

		listWindowsDef.server(async ({ deviceId }) => {
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

		listDevicesDef.server(async () => {
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

		countByDomainDef.server(async ({ deviceId }) => {
			const tabs = tables.tabs.filter((tab) => {
				if (deviceId && tab.deviceId !== deviceId) return false;
				return true;
			});
			const counts = new Map<string, number>();
			for (const tab of tabs) {
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
	];
}
