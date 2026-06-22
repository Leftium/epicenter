import { type Command, commands } from '$lib/commands';
import {
	type CommandId,
	localShortcuts,
} from '$lib/services/local-shortcut-manager';
import { settings } from '$lib/state/settings.svelte';
import {
	bindingsEqual,
	keyBindingToString,
	parseManualBinding,
} from '$lib/utils/key-binding';
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * The focused (in-app) shortcut backend: shortcuts that fire while the Whispering
 * window is focused, driven by the browser keydown matcher and stored in workspace
 * KV under `shortcut.*` as the readable manual grammar (`"ctrl+shift+a"`). The KV
 * cell is `field.string()` either way; this just speaks the same physical
 * `KeyBinding` the matcher and the system tier use, parsed on read and serialized
 * on write.
 *
 * Universal, not a `#platform` seam: the webview matcher runs in the Tauri window
 * too, so this same backend is the focused half on every platform. The reach
 * router (`shortcuts.ts`) composes it with the Tauri-only `systemShortcuts`; on
 * desktop both run, on web this is the only one. See ADR-0052.
 */

const localKey = (id: Command['id']) => `shortcut.${id}` as const;

/** A stored shortcut string, parsed to a `KeyBinding` (`null` when unset or stale). */
const readBinding = (id: Command['id']) => {
	const stored = settings.get(localKey(id));
	return stored ? parseManualBinding(stored) : null;
};

export const focusedShortcuts: Shortcuts = createShortcuts({
	read: readBinding,
	getDefault: (id) => {
		const stored = settings.getDefault(localKey(id));
		return stored ? parseManualBinding(stored) : null;
	},
	write: (id, binding) =>
		settings.set(localKey(id), binding ? keyBindingToString(binding) : null),
	// The keydown matcher fires every command whose set matches, so two commands
	// sharing a set would both trigger. Refuse an exact duplicate at write time.
	findConflict: (id, binding) => {
		for (const command of commands) {
			if (command.id === id) continue;
			const other = readBinding(command.id);
			if (other && bindingsEqual(other, binding)) {
				return `Those keys already trigger "${command.title}". Pick a different combination.`;
			}
		}
		return null;
	},
	syncErrorTitle: 'Error registering local commands',
	// Registration is an in-memory Map write, so it cannot fail: push always
	// succeeds. The contract stays async because the desktop tier's push does IPC.
	async push(entries) {
		for (const { command, binding } of entries) {
			if (binding) localShortcuts.registerCommand({ command, binding });
			else
				localShortcuts.unregisterCommand({
					commandId: command.id as CommandId,
				});
		}
		return null;
	},
});
