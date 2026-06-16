import { partitionResults } from 'wellcrafted/result';
import type { Command } from '$lib/commands';
import {
	type CommandId,
	localShortcuts,
	shortcutStringToArray,
} from '$lib/services/local-shortcut-manager';
import { settings } from '$lib/state/settings.svelte';
import { getShortcutDisplayLabel } from '$lib/utils/keyboard';
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * Web build of `#platform/shortcuts`: in-app (focused-window) shortcuts driven
 * by the browser keydown manager, stored in workspace KV under `shortcut.*`.
 */

const localKey = (id: Command['id']) => `shortcut.${id}` as const;

export const shortcuts: Shortcuts = createShortcuts<string>({
	read: (id) => settings.get(localKey(id)),
	getDefault: (id) => settings.getDefault(localKey(id)),
	write: (id, binding) => settings.set(localKey(id), binding),
	label: (binding) => getShortcutDisplayLabel(binding),
	syncErrorTitle: 'Error registering local commands',
	async push(entries) {
		const results = await Promise.all(
			entries.map(({ command, binding }) =>
				binding
					? localShortcuts.registerCommand({
							command,
							keyCombination: shortcutStringToArray(binding),
						})
					: localShortcuts.unregisterCommand({
							commandId: command.id as CommandId,
						}),
			),
		);
		const { errs } = partitionResults(results);
		if (errs.length === 0) return null;
		return {
			name: 'LocalShortcutRegistrationFailed',
			message: errs.map((err) => err.error.message).join('\n'),
		};
	},
});
