import { partitionResults } from 'wellcrafted/result';
import { os } from '#platform/os';
import type { Command } from '$lib/commands';
import {
	type CommandId,
	localShortcuts,
} from '$lib/services/local-shortcut-manager';
import { settings } from '$lib/state/settings.svelte';
import {
	keyBindingToLabel,
	keyBindingToString,
	parseManualBinding,
} from '$lib/utils/key-binding';
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * Web build of `#platform/shortcuts`: in-app (focused-window) shortcuts driven
 * by the browser keydown manager, stored in workspace KV under `shortcut.*` as
 * the readable manual grammar (`"ctrl+shift+a"`). The KV cell is `field.string()`
 * either way; this just speaks the same physical `KeyBinding` the matcher and the
 * desktop tier use, parsed on read and serialized on write.
 */

const localKey = (id: Command['id']) => `shortcut.${id}` as const;

/** A stored shortcut string, parsed to a `KeyBinding` (`null` when unset or stale). */
const readBinding = (id: Command['id']) => {
	const stored = settings.get(localKey(id));
	return stored ? parseManualBinding(stored) : null;
};

export const shortcuts: Shortcuts = createShortcuts({
	read: readBinding,
	getDefault: (id) => {
		const stored = settings.getDefault(localKey(id));
		return stored ? parseManualBinding(stored) : null;
	},
	write: (id, binding) =>
		settings.set(localKey(id), binding ? keyBindingToString(binding) : null),
	label: (binding) => (binding ? keyBindingToLabel(binding, os.isApple) : ''),
	syncErrorTitle: 'Error registering local commands',
	async push(entries) {
		const results = await Promise.all(
			entries.map(({ command, binding }) =>
				binding
					? localShortcuts.registerCommand({ command, binding })
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
