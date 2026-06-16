import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { os } from '#platform/os';
import { goto } from '$app/navigation';
import { type Command, commands } from '$lib/commands';
import { report } from '$lib/report';
import {
	DEFAULT_GLOBAL_BINDINGS,
	deviceConfig,
} from '$lib/state/device-config.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';
import { tauriOnly } from '$lib/tauri.tauri';
import { keyBindingToLabel } from '$lib/utils/key-binding';
import type { Shortcuts } from './types';

/**
 * Desktop build of `#platform/shortcuts`: system-global gestures driven by the
 * rdev backend, stored in device-config under `shortcuts.global.*` (never
 * synced across devices). The default bindings live in `DEFAULT_GLOBAL_BINDINGS`
 * because they double as the device-config schema defaults.
 */

const globalKey = (id: Command['id']) => `shortcuts.global.${id}` as const;

/** Canonical string for a binding, so structurally-equal bindings dedupe. */
function bindingKey(binding: {
	modifiers: readonly string[];
	keys: readonly string[];
}): string {
	return JSON.stringify({
		modifiers: [...binding.modifiers].sort(),
		keys: [...binding.keys].sort(),
	});
}

async function sync(): Promise<void> {
	const bindings: CommandBinding[] = [];
	for (const command of commands) {
		const binding = deviceConfig.get(globalKey(command.id));
		if (!binding) continue;
		// Storage validates keys as plain strings; Rust validates them by name on
		// register. The cast bridges the stored `string[]` to the IPC `Key[]`.
		bindings.push({ commandId: command.id, binding: binding as KeyBinding });
	}
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
	if (error) {
		report.error({ title: 'Error registering global shortcuts', cause: error });
	}
}

function reset(): void {
	for (const command of commands) {
		deviceConfig.set(
			globalKey(command.id),
			DEFAULT_GLOBAL_BINDINGS[command.id] ?? null,
		);
	}
	void sync();
}

function resetIfDuplicates(): boolean {
	const seen = new Map<string, string>();
	for (const command of commands) {
		const binding = deviceConfig.get(globalKey(command.id));
		if (!binding) continue;
		const key = bindingKey(binding);
		if (seen.has(key)) {
			reset();
			report.success({
				title: 'Shortcuts reset',
				description:
					'Duplicate global shortcuts detected. All global shortcuts have been reset to defaults.',
				action: {
					label: 'Configure shortcuts',
					onClick: () => goto('/settings/shortcuts'),
				},
			});
			return true;
		}
		seen.set(key, command.id);
	}
	return false;
}

function defaultLabel(commandId: Command['id']): string {
	const binding = DEFAULT_GLOBAL_BINDINGS[commandId];
	return binding ? keyBindingToLabel(binding, os.isApple) : '';
}

export const shortcuts: Shortcuts = {
	sync,
	reset,
	resetIfDuplicates,
	defaultLabel,
};
