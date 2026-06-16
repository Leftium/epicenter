import { partitionResults } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import { type Command, commands } from '$lib/commands';
import { localShortcuts } from '$lib/services/local-shortcut-manager';
import { report } from '$lib/report';
import {
	type CommandId,
	shortcutStringToArray,
} from '$lib/services/local-shortcut-manager';
import { settings } from '$lib/state/settings.svelte';
import { getShortcutDisplayLabel } from '$lib/utils/keyboard';
import type { Shortcuts } from './types';

/**
 * Web build of `#platform/shortcuts`: in-app (focused-window) shortcuts driven
 * by the browser keydown manager, stored in workspace KV under `shortcut.*`.
 */

const localKey = (id: Command['id']) => `shortcut.${id}` as const;

async function sync(): Promise<void> {
	const results = await Promise.all(
		commands
			.map((command) => {
				const keyCombination = settings.get(localKey(command.id));
				if (!keyCombination) {
					return localShortcuts.unregisterCommand({
						commandId: command.id as CommandId,
					});
				}
				return localShortcuts.registerCommand({
					command,
					keyCombination: shortcutStringToArray(String(keyCombination)),
				});
			})
			.filter((result) => result !== undefined),
	);
	const { errs } = partitionResults(results);
	if (errs.length > 0) {
		report.error({
			title: 'Error registering local commands',
			cause: {
				name: 'LocalShortcutRegistrationFailed',
				message: errs.map((err) => err.error.message).join('\n'),
			},
		});
	}
}

function reset(): void {
	for (const command of commands) {
		const key = localKey(command.id);
		settings.set(key, settings.getDefault(key));
	}
	void sync();
}

function resetIfDuplicates(): boolean {
	const seen = new Map<string, string>();
	for (const command of commands) {
		const shortcut = settings.get(localKey(command.id));
		if (!shortcut) continue;
		if (seen.has(String(shortcut))) {
			reset();
			report.success({
				title: 'Shortcuts reset',
				description:
					'Duplicate local shortcuts detected. All local shortcuts have been reset to defaults.',
				action: {
					label: 'Configure shortcuts',
					onClick: () => goto('/settings/shortcuts'),
				},
			});
			return true;
		}
		seen.set(String(shortcut), command.id);
	}
	return false;
}

function defaultLabel(commandId: Command['id']): string {
	return getShortcutDisplayLabel(settings.getDefault(localKey(commandId)));
}

export const shortcuts: Shortcuts = {
	sync,
	reset,
	resetIfDuplicates,
	defaultLabel,
};
