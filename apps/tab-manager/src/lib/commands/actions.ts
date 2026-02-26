/**
 * Per-action Chrome API execution functions.
 *
 * Each function receives the command payload, executes the corresponding
 * Chrome browser API, and returns the result. Called by the command consumer
 * after filtering for this device and checking TTL.
 */

import type { TableHelper } from '@epicenter/workspace';
import { generateId } from '@epicenter/workspace';
import type { DeviceId, SavedTab, SavedTabId } from '$lib/workspace';
import { parseTabId } from '$lib/workspace';

/**
 * Extract the native tab ID (number) from a composite tab ID string.
 *
 * Composite format: `${deviceId}_${tabId}`. Returns the number portion.
 * Returns `undefined` if the composite ID doesn't belong to this device.
 */
function nativeTabId(
	compositeId: string,
	deviceId: DeviceId,
): number | undefined {
	const parsed = parseTabId(compositeId as Parameters<typeof parseTabId>[0]);
	if (!parsed || parsed.deviceId !== deviceId) return undefined;
	return parsed.tabId;
}

/**
 * Close the specified tabs.
 */
export async function executeCloseTabs(
	tabIds: string[],
	deviceId: DeviceId,
): Promise<{ closedCount: number }> {
	const nativeIds = tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);

	let closedCount = 0;
	for (const id of nativeIds) {
		try {
			await browser.tabs.remove(id);
			closedCount++;
		} catch {
			// Tab may already be closed
		}
	}
	return { closedCount };
}

/**
 * Open a new tab with the given URL.
 */
export async function executeOpenTab(
	url: string,
	_windowId?: string,
): Promise<{ tabId: string }> {
	const tab = await browser.tabs.create({ url });
	return { tabId: String(tab.id ?? -1) };
}

/**
 * Activate (focus) a specific tab.
 */
export async function executeActivateTab(
	compositeTabId: string,
	deviceId: DeviceId,
): Promise<{ activated: boolean }> {
	const id = nativeTabId(compositeTabId, deviceId);
	if (id === undefined) return { activated: false };

	try {
		await browser.tabs.update(id, { active: true });
		return { activated: true };
	} catch {
		return { activated: false };
	}
}

/**
 * Save tabs to the savedTabs table, optionally closing them.
 */
export async function executeSaveTabs(
	tabIds: string[],
	close: boolean,
	deviceId: DeviceId,
	savedTabsTable: TableHelper<SavedTab>,
): Promise<{ savedCount: number }> {
	let savedCount = 0;
	for (const compositeId of tabIds) {
		const id = nativeTabId(compositeId, deviceId);
		if (id === undefined) continue;

		try {
			const tab = await browser.tabs.get(id);
			if (!tab.url) continue;

			savedTabsTable.set({
				id: generateId() as string as SavedTabId,
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
				pinned: tab.pinned ?? false,
				sourceDeviceId: deviceId,
				savedAt: Date.now(),
				_v: 1,
			});
			savedCount++;

			if (close) {
				await browser.tabs.remove(id);
			}
		} catch {
			// Tab may have been closed already
		}
	}
	return { savedCount };
}

/**
 * Group tabs together with an optional title and color.
 */
export async function executeGroupTabs(
	tabIds: string[],
	deviceId: DeviceId,
	title?: string,
	color?: string,
): Promise<{ groupId: string }> {
	const nativeIds = tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);

	const groupId = await browser.tabs.group({ tabIds: nativeIds });

	if (title || color) {
		const updateProps: browser.TabGroups.UpdateProperties = {};
		if (title) updateProps.title = title;
		if (color) updateProps.color = color as browser.TabGroups.ColorEnum;
		await browser.tabGroups.update(groupId, updateProps);
	}

	return { groupId: String(groupId) };
}

/**
 * Pin or unpin tabs.
 */
export async function executePinTabs(
	tabIds: string[],
	pinned: boolean,
	deviceId: DeviceId,
): Promise<{ pinnedCount: number }> {
	const nativeIds = tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);

	let pinnedCount = 0;
	for (const id of nativeIds) {
		try {
			await browser.tabs.update(id, { pinned });
			pinnedCount++;
		} catch {
			// Tab may not exist
		}
	}
	return { pinnedCount };
}

/**
 * Mute or unmute tabs.
 */
export async function executeMuteTabs(
	tabIds: string[],
	muted: boolean,
	deviceId: DeviceId,
): Promise<{ mutedCount: number }> {
	const nativeIds = tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);

	let mutedCount = 0;
	for (const id of nativeIds) {
		try {
			await browser.tabs.update(id, { muted });
			mutedCount++;
		} catch {
			// Tab may not exist
		}
	}
	return { mutedCount };
}

/**
 * Reload tabs.
 */
export async function executeReloadTabs(
	tabIds: string[],
	deviceId: DeviceId,
): Promise<{ reloadedCount: number }> {
	const nativeIds = tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);

	let reloadedCount = 0;
	for (const id of nativeIds) {
		try {
			await browser.tabs.reload(id);
			reloadedCount++;
		} catch {
			// Tab may not exist
		}
	}
	return { reloadedCount };
}
