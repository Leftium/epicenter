/**
 * Per-action Chrome API execution functions.
 *
 * Each function receives the action payload, executes the corresponding
 * Chrome browser API, and returns the result. Used by the `.withActions()`
 * mutation handlers in workspace.ts.
 */
import type { TableHelper } from '@epicenter/workspace';
import {
	generateSavedTabId,
	type DeviceId,
	parseTabId,
	type SavedTab,
	type SavedTabId,
} from '$lib/workspace';

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
 * Batch-resolve composite tab IDs to native Chrome tab IDs.
 *
 * Filters out IDs that don't belong to the given device.
 */
function toNativeIds(tabIds: string[], deviceId: DeviceId): number[] {
	return tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);
}

/**
 * Close the specified browser tabs by their composite IDs.
 *
 * Resolves each composite ID to a native Chrome tab ID scoped to `deviceId`,
 * then batch-removes them. IDs belonging to other devices are silently ignored.
 * Chrome API failures are swallowed—`closedCount` reflects the number of tabs
 * targeted, not confirmed closed (Chrome doesn't report individual failures).
 *
 * @param tabIds - Composite tab IDs in `${deviceId}_${nativeId}` format
 * @param deviceId - The local device ID used to filter composite IDs
 * @returns The number of tabs targeted for removal
 *
 * @example
 * ```typescript
 * const { closedCount } = await executeCloseTabs(
 *   ['device1_42', 'device1_99', 'device2_7'],
 *   DeviceId('device1'),
 * );
 * // closedCount === 2 (device2_7 is ignored)
 * ```
 */
export async function executeCloseTabs(
	tabIds: string[],
	deviceId: DeviceId,
): Promise<{ closedCount: number }> {
	const nativeIds = toNativeIds(tabIds, deviceId);

	await tryAsync({
		try: () => browser.tabs.remove(nativeIds),
		catch: () => Ok(undefined),
	});
	return { closedCount: nativeIds.length };
}

/**
 * Open a new browser tab at the given URL.
 *
 * Creates a tab via `browser.tabs.create`. If the Chrome API call fails
 * (e.g., invalid URL, extension permissions), returns `tabId: "-1"` as a
 * sentinel value instead of throwing.
 *
 * @param url - The URL to open in the new tab
 * @param _windowId - Reserved for future use (target window)
 * @returns The string-encoded native tab ID, or `"-1"` on failure
 *
 * @example
 * ```typescript
 * const { tabId } = await executeOpenTab('https://example.com');
 * if (tabId === '-1') console.error('Failed to open tab');
 * ```
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
 * Activate (bring to focus) a specific browser tab.
 *
 * Resolves the composite ID to a native tab ID scoped to `deviceId`.
 * If the ID belongs to a different device or the tab no longer exists,
 * returns `{ activated: false }` without throwing.
 *
 * @param compositeTabId - Composite tab ID in `${deviceId}_${nativeId}` format
 * @param deviceId - The local device ID used to scope the lookup
 * @returns Whether the tab was successfully activated
 *
 * @example
 * ```typescript
 * const { activated } = await executeActivateTab('device1_42', deviceId);
 * if (!activated) console.warn('Tab not found or not on this device');
 * ```
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
 * Save browser tabs to the Y.Doc savedTabs table, optionally closing them.
 *
 * Fetches full tab metadata via `Promise.allSettled` (tolerating tabs that
 * vanished between query and fetch), filters to tabs with valid URLs, writes
 * each to the CRDT-backed savedTabs table, and optionally batch-closes them.
 * Tabs without URLs (e.g., `chrome://` pages) are silently skipped.
 *
 * @param tabIds - Composite tab IDs to save
 * @param close - Whether to close the tabs after saving
 * @param deviceId - The local device ID used to scope composite IDs
 * @param savedTabsTable - The Y.Doc table helper for persisting saved tabs
 * @returns The number of tabs successfully saved
 *
 * @example
 * ```typescript
 * const { savedCount } = await executeSaveTabs(
 *   selectedTabIds,
 *   true, // close after saving
 *   deviceId,
 *   workspace.tables.savedTabs,
 * );
 * ```
 */
export async function executeSaveTabs(
	tabIds: string[],
	close: boolean,
	deviceId: DeviceId,
	savedTabsTable: TableHelper<SavedTab>,
): Promise<{ savedCount: number }> {
	const nativeIds = toNativeIds(tabIds, deviceId);

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
}

/**
 * Group browser tabs together with an optional title and color.
 *
 * Creates a Chrome tab group from the resolved native IDs, then optionally
 * applies a title and/or color. If grouping fails (e.g., tabs don't exist),
 * returns `groupId: "-1"`. If the group is created but title/color update
 * fails, the group still exists—the cosmetic failure is swallowed.
 *
 * @param tabIds - Composite tab IDs to group
 * @param deviceId - The local device ID used to scope composite IDs
 * @param title - Optional group label shown in the tab strip
 * @param color - Optional group color (Chrome tab group color name)
 * @returns The string-encoded group ID, or `"-1"` on failure
 *
 * @example
 * ```typescript
 * const { groupId } = await executeGroupTabs(
 *   tabIds, deviceId, 'Research', 'blue',
 * );
 * ```
 */
export async function executeGroupTabs(
	tabIds: string[],
	deviceId: DeviceId,
	title?: string,
	color?: string,
): Promise<{ groupId: string }> {
	const nativeIds = toNativeIds(tabIds, deviceId);

	const { data: groupId, error: groupError } = await tryAsync({
		try: () =>
			browser.tabs.group({ tabIds: nativeIds as [number, ...number[]] }),
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
 * Pin or unpin browser tabs.
 *
 * Applies the pin state to each resolved native tab ID via `Promise.allSettled`,
 * tolerating individual failures (e.g., tab closed mid-operation). Returns the
 * count of tabs that were successfully updated.
 *
 * @param tabIds - Composite tab IDs to pin/unpin
 * @param pinned - `true` to pin, `false` to unpin
 * @param deviceId - The local device ID used to scope composite IDs
 * @returns The number of tabs successfully pinned/unpinned
 *
 * @example
 * ```typescript
 * const { pinnedCount } = await executePinTabs(tabIds, true, deviceId);
 * ```
 */
export async function executePinTabs(
	tabIds: string[],
	pinned: boolean,
	deviceId: DeviceId,
): Promise<{ pinnedCount: number }> {
	const nativeIds = toNativeIds(tabIds, deviceId);

	const results = await Promise.allSettled(
		nativeIds.map((id) => browser.tabs.update(id, { pinned })),
	);
	return {
		pinnedCount: results.filter((r) => r.status === 'fulfilled').length,
	};
}

/**
 * Mute or unmute browser tabs.
 *
 * Applies the mute state to each resolved native tab ID via `Promise.allSettled`,
 * tolerating individual failures. Returns the count of tabs successfully updated.
 *
 * @param tabIds - Composite tab IDs to mute/unmute
 * @param muted - `true` to mute, `false` to unmute
 * @param deviceId - The local device ID used to scope composite IDs
 * @returns The number of tabs successfully muted/unmuted
 *
 * @example
 * ```typescript
 * const { mutedCount } = await executeMuteTabs(tabIds, true, deviceId);
 * ```
 */
export async function executeMuteTabs(
	tabIds: string[],
	muted: boolean,
	deviceId: DeviceId,
): Promise<{ mutedCount: number }> {
	const nativeIds = toNativeIds(tabIds, deviceId);

	const results = await Promise.allSettled(
		nativeIds.map((id) => browser.tabs.update(id, { muted })),
	);
	return { mutedCount: results.filter((r) => r.status === 'fulfilled').length };
}

/**
 * Reload browser tabs.
 *
 * Triggers a reload on each resolved native tab ID via `Promise.allSettled`,
 * tolerating individual failures (e.g., tab closed mid-operation). Returns the
 * count of tabs that were successfully reloaded.
 *
 * @param tabIds - Composite tab IDs to reload
 * @param deviceId - The local device ID used to scope composite IDs
 * @returns The number of tabs successfully reloaded
 *
 * @example
 * ```typescript
 * const { reloadedCount } = await executeReloadTabs(tabIds, deviceId);
 * ```
 */
export async function executeReloadTabs(
	tabIds: string[],
	deviceId: DeviceId,
): Promise<{ reloadedCount: number }> {
	const nativeIds = toNativeIds(tabIds, deviceId);

	const results = await Promise.allSettled(
		nativeIds.map((id) => browser.tabs.reload(id)),
	);
	return {
		reloadedCount: results.filter((r) => r.status === 'fulfilled').length,
	};
}
