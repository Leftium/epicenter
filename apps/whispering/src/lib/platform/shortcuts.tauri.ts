import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { os } from '#platform/os';
import type { Command } from '$lib/commands';
import {
	DEFAULT_GLOBAL_BINDINGS,
	deviceConfig,
} from '$lib/state/device-config.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';
import { tauriOnly } from '$lib/tauri.tauri';
import { keyBindingToLabel } from '$lib/utils/key-binding';
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * Desktop build of `#platform/shortcuts`: system-global gestures driven by the
 * rdev backend, stored in device-config under `shortcuts.global.*` (never
 * synced across devices). The default bindings live in `DEFAULT_GLOBAL_BINDINGS`
 * because they double as the device-config schema defaults.
 */

const globalKey = (id: Command['id']) => `shortcuts.global.${id}` as const;

function readBinding(id: Command['id']) {
	return deviceConfig.get(globalKey(id));
}

/** The stored global-binding shape (`keys` are plain strings, validated by Rust). */
type GlobalBinding = NonNullable<ReturnType<typeof readBinding>>;

export const shortcuts: Shortcuts = createShortcuts<GlobalBinding>({
	read: readBinding,
	getDefault: (id) => DEFAULT_GLOBAL_BINDINGS[id] ?? null,
	write: (id, binding) => deviceConfig.set(globalKey(id), binding),
	label: (binding) => (binding ? keyBindingToLabel(binding, os.isApple) : ''),
	syncErrorTitle: 'Error registering global shortcuts',
	async push(entries) {
		// Storage validates keys as plain strings; Rust validates them by name on
		// register. The cast bridges the stored `string[]` to the IPC `Key[]`.
		const bindings: CommandBinding[] = entries
			.filter((entry) => entry.binding !== null)
			.map((entry) => ({
				commandId: entry.command.id,
				binding: entry.binding as KeyBinding,
			}));
		// Keys are validated by Rust at the IPC boundary, so a single bad key fails
		// the whole replace-all call. Surface it instead of silently unregistering.
		const { error } = await tryAsync({
			try: () => tauriOnly.globalShortcuts.setBindings(bindings),
			catch: (cause) =>
				Err({
					name: 'GlobalShortcutRegistrationFailed',
					message: extractErrorMessage(cause),
				}),
		});
		return error ?? null;
	},
});
