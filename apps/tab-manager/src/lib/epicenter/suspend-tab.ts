/**
 * Suspend and restore tab helpers.
 *
 * These operate on the shared `suspended_tabs` table and the browser tabs API.
 * Suspending saves a tab's essential data to Yjs and closes the browser tab.
 * Restoring opens the URL locally and removes the row from Yjs.
 *
 * Neither function touches `background.ts` or the live tab sync layer.
 */

import { generateId } from '@epicenter/hq/dynamic';
import type { SuspendedTab, Tab } from './browser.schema';
import type { BrowserDb } from './schema';

/**
 * Suspend a browser tab — save it to the `suspended_tabs` table and close it.
 *
 * Reads the tab's essential data (url, title, favicon, pinned state),
 * writes a row to `suspended_tabs`, then closes the browser tab.
 * The existing `onRemoved` handler in background.ts handles cleanup
 * of the live `tabs` table row automatically.
 *
 * @example
 * ```typescript
 * await suspendTab(tables, deviceId, tab);
 * ```
 */
export async function suspendTab(
	tables: BrowserDb,
	deviceId: string,
	tab: Tab,
): Promise<void> {
	tables.suspended_tabs.set({
		id: generateId(),
		url: tab.url,
		title: tab.title || 'Untitled',
		fav_icon_url: tab.fav_icon_url,
		pinned: tab.pinned,
		source_device_id: deviceId,
		suspended_at: Date.now(),
	});

	await browser.tabs.remove(tab.tab_id);
}

/**
 * Restore a suspended tab — open it in the browser and delete the saved row.
 *
 * Creates a new browser tab with the suspended tab's URL and pinned state,
 * then removes the row from `suspended_tabs`. The existing `onCreated`
 * handler in background.ts adds the new tab to the live `tabs` table
 * automatically.
 *
 * @example
 * ```typescript
 * await restoreTab(tables, suspendedTab);
 * ```
 */
export async function restoreTab(
	tables: BrowserDb,
	suspendedTab: SuspendedTab,
): Promise<void> {
	await browser.tabs.create({
		url: suspendedTab.url,
		pinned: suspendedTab.pinned,
	});

	tables.suspended_tabs.delete(suspendedTab.id);
}

/**
 * Delete a suspended tab without restoring it.
 *
 * Simply removes the row from the `suspended_tabs` table.
 * The tab is permanently discarded.
 *
 * @example
 * ```typescript
 * deleteSuspendedTab(tables, suspendedTab.id);
 * ```
 */
export function deleteSuspendedTab(tables: BrowserDb, id: string): void {
	tables.suspended_tabs.delete(id);
}

/**
 * Update a suspended tab's URL or title.
 *
 * Writes the full row back with updated fields. Uses Yjs LWW semantics
 * so last writer wins across devices.
 *
 * @example
 * ```typescript
 * updateSuspendedTab(tables, { ...suspendedTab, title: 'New Title' });
 * ```
 */
export function updateSuspendedTab(
	tables: BrowserDb,
	suspendedTab: SuspendedTab,
): void {
	tables.suspended_tabs.set(suspendedTab);
}
