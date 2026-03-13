/**
 * Per-action Chrome API execution functions.
 *
 * Each function receives the action payload, executes the corresponding
 * Chrome browser API, and returns the result. Used by the `.withActions()`
 * mutation handlers in workspace.ts.
 */
import type { TableHelper } from '@epicenter/workspace';
import { generateId } from '@epicenter/workspace';
import { Ok, tryAsync } from 'wellcrafted/result';
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

	await tryAsync({
		try: () => browser.tabs.remove(nativeIds),
		catch: () => Ok(undefined),
	});
	return { closedCount: nativeIds.length };
}

/**
 * Open a new tab with the given URL.
 */
export async function executeOpenTab(
	url: string,
	_windowId?: string,
): Promise<{ tabId: string }> {
	const { data: tab, error } = await tryAsync({
		try: () => browser.tabs.create({ url }),
		catch: () => Ok(undefined),
	});
	if (error || !tab) return { tabId: String(-1) };
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

	const { error } = await tryAsync({
		try: () => browser.tabs.update(id, { active: true }),
		catch: () => Ok(undefined),
	});
	return { activated: !error };
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
	const nativeIds = tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);

	// Fetch all tabs in parallel
	const results = await Promise.allSettled(
		nativeIds.map((id) => browser.tabs.get(id)),
	);

	const validTabs = results.flatMap((r) => {
		if (r.status !== 'fulfilled' || !r.value.url) return [];
		return [{ ...r.value, url: r.value.url }];
	});

	// Sync writes to Y.Doc
	for (const tab of validTabs) {
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

	const { data: groupId, error: groupError } = await tryAsync({
		try: () => browser.tabs.group({ tabIds: nativeIds as [number, ...number[]] }),
		catch: () => Ok(undefined),
	});
	if (groupError || groupId === undefined) return { groupId: String(-1) };

	if (title || color) {
		const updateProps: Browser.tabGroups.UpdateProperties = {};
		if (title) updateProps.title = title;
		if (color) updateProps.color = color as `${Browser.tabGroups.Color}`;
		await tryAsync({
			try: () => browser.tabGroups.update(groupId as number, updateProps),
			catch: () => Ok(undefined),
		});
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

	const results = await Promise.allSettled(
		nativeIds.map((id) => browser.tabs.update(id, { pinned })),
	);
	return {
		pinnedCount: results.filter((r) => r.status === 'fulfilled').length,
	};
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

	const results = await Promise.allSettled(
		nativeIds.map((id) => browser.tabs.update(id, { muted })),
	);
	return { mutedCount: results.filter((r) => r.status === 'fulfilled').length };
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

	const results = await Promise.allSettled(
		nativeIds.map((id) => browser.tabs.reload(id)),
	);
	return {
		reloadedCount: results.filter((r) => r.status === 'fulfilled').length,
	};
}
