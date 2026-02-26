/**
 * Command consumer — observes the commands table and executes Chrome APIs.
 *
 * Filters for commands targeting this device, checks TTL, dispatches by action,
 * and writes the result back. Expired commands are deleted.
 *
 * @see specs/20260223T200500-ai-tools-command-queue.md
 */

import type { TableHelper } from '@epicenter/workspace';
import type { Command, DeviceId, SavedTab } from '$lib/workspace';
import {
	executeActivateTab,
	executeCloseTabs,
	executeGroupTabs,
	executeMuteTabs,
	executeOpenTab,
	executePinTabs,
	executeReloadTabs,
	executeSaveTabs,
} from './actions';
import { COMMAND_TTL_MS } from './constants';

/**
 * Start observing the commands table and executing commands for this device.
 *
 * Returns an unsubscribe function to stop the observer.
 *
 * @param commandsTable - The table helper for the commands table
 * @param savedTabsTable - The table helper for the savedTabs table (needed by saveTabs action)
 * @param deviceId - This device's ID
 */
export function startCommandConsumer(
	commandsTable: TableHelper<Command>,
	savedTabsTable: TableHelper<SavedTab>,
	deviceId: DeviceId,
): () => void {
	return commandsTable.observe((changedIds) => {
		for (const id of changedIds) {
			const result = commandsTable.get(id);
			if (result.status !== 'valid') continue;

			const cmd = result.row;

			// Only process commands targeting this device
			if (cmd.deviceId !== deviceId) continue;

			// Skip already-completed commands
			if (cmd.result !== undefined) continue;

			// Check TTL — delete expired commands, skip execution
			const isExpired = cmd.createdAt + COMMAND_TTL_MS < Date.now();
			if (isExpired) {
				commandsTable.delete(id);
				continue;
			}

			// Dispatch by action and write result
			void executeCommand(cmd, commandsTable, savedTabsTable, deviceId);
		}
	});
}

/**
 * Execute a single command and write the result back to the table.
 */
async function executeCommand(
	cmd: Command,
	commandsTable: TableHelper<Command>,
	savedTabsTable: TableHelper<SavedTab>,
	deviceId: DeviceId,
): Promise<void> {
	try {
		let commandResult: unknown;

		switch (cmd.action) {
			case 'closeTabs':
				commandResult = await executeCloseTabs(cmd.tabIds, deviceId);
				break;
			case 'openTab':
				commandResult = await executeOpenTab(cmd.url, cmd.windowId);
				break;
			case 'activateTab':
				commandResult = await executeActivateTab(cmd.tabId, deviceId);
				break;
			case 'saveTabs':
				commandResult = await executeSaveTabs(
					cmd.tabIds,
					cmd.close,
					deviceId,
					savedTabsTable,
				);
				break;
			case 'groupTabs':
				commandResult = await executeGroupTabs(
					cmd.tabIds,
					deviceId,
					cmd.title,
					cmd.color,
				);
				break;
			case 'pinTabs':
				commandResult = await executePinTabs(cmd.tabIds, cmd.pinned, deviceId);
				break;
			case 'muteTabs':
				commandResult = await executeMuteTabs(cmd.tabIds, cmd.muted, deviceId);
				break;
			case 'reloadTabs':
				commandResult = await executeReloadTabs(cmd.tabIds, deviceId);
				break;
		}

		// Write result back — cast needed because discriminated union narrows
		// per-action but we're writing the generic Command shape back
		commandsTable.set({ ...cmd, result: commandResult } as Command);
	} catch (error) {
		console.error('[Commands] Failed to execute command:', cmd.action, error);
	}
}
