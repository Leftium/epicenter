/**
 * BGSW mutation tool implementations.
 *
 * Each tool calls Chrome APIs directly — no command queue, no Y.Doc sync
 * round-trip, no `waitForCommandResult()`. This is the core deduplication:
 * the server's mutation tools wrote commands to a table and waited for
 * the BGSW to execute them. Now the BGSW runs `chat()` directly and
 * calls Chrome APIs inline.
 *
 * Reuses the existing action implementations from `$lib/commands/actions.ts`.
 * Those functions already encapsulate the Chrome API calls — they just
 * needed a different caller.
 */

import type { TableHelper } from '@epicenter/hq';
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
import type { DeviceId, SavedTab } from '$lib/workspace';
import {
	activateTabDef,
	closeTabsDef,
	groupTabsDef,
	muteTabsDef,
	openTabDef,
	pinTabsDef,
	reloadTabsDef,
	saveTabsDef,
} from './definitions';

/**
 * Dependencies required by mutation tools.
 *
 * Mutation tools need the device ID (to resolve composite tab IDs) and
 * the savedTabs table (for the saveTabs action).
 */
export type MutationToolDeps = {
	/** This device's ID — used to resolve composite tab IDs for Chrome API calls. */
	deviceId: DeviceId;
	/** The savedTabs table helper — needed by `executeSaveTabs` to persist saved tabs. */
	savedTabsTable: TableHelper<SavedTab>;
};

/**
 * Create BGSW mutation tools that call Chrome APIs directly.
 *
 * Eliminates the command queue entirely for local-device mutations:
 * - Server mutation tools: write command → Y.Doc sync → BGSW execute → sync result back (~1s)
 * - BGSW mutation tools: call Chrome API directly (<10ms)
 *
 * @param deps - Device ID and table helpers needed for Chrome API execution
 * @returns Array of server tools ready for `chat({ tools })`
 */
export function createMutationTools(deps: MutationToolDeps) {
	const { deviceId, savedTabsTable } = deps;

	return [
		closeTabsDef.server(async ({ tabIds }) => {
			return await executeCloseTabs(tabIds, deviceId);
		}),

		openTabDef.server(async ({ url, windowId }) => {
			return await executeOpenTab(url, windowId);
		}),

		activateTabDef.server(async ({ tabId }) => {
			return await executeActivateTab(tabId, deviceId);
		}),

		saveTabsDef.server(async ({ tabIds, close }) => {
			return await executeSaveTabs(
				tabIds,
				close ?? false,
				deviceId,
				savedTabsTable,
			);
		}),

		groupTabsDef.server(async ({ tabIds, title, color }) => {
			return await executeGroupTabs(tabIds, deviceId, title, color);
		}),

		pinTabsDef.server(async ({ tabIds, pinned }) => {
			return await executePinTabs(tabIds, pinned, deviceId);
		}),

		muteTabsDef.server(async ({ tabIds, muted }) => {
			return await executeMuteTabs(tabIds, muted, deviceId);
		}),

		reloadTabsDef.server(async ({ tabIds }) => {
			return await executeReloadTabs(tabIds, deviceId);
		}),
	];
}
