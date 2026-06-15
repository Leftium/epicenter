import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import type { Command } from '$lib/commands';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { keyBindingToLabel } from '$lib/utils/key-binding';
import { getShortcutDisplayLabel } from '$lib/utils/keyboard';

/**
 * The label for the shortcut that is actually live on this platform.
 *
 * Desktop and browser run different shortcut systems that never coexist: the
 * desktop app matches global rdev bindings (`deviceConfig`), the browser matches
 * in-app shortcuts (workspace KV). Reading the wrong one surfaces a stale default
 * (the untouched in-app `' '` renders as "Space" on desktop, even after the user
 * rebinds the global gesture), so every display of a recording shortcut routes
 * through here to reflect the genuine binding.
 *
 * Returns `''` when the effective binding is unset; callers treat that as "no
 * shortcut" (hide the badge, fall back to "click" copy).
 */
export function getEffectiveShortcutLabel(command: Command['id']): string {
	if (tauri) {
		const binding = deviceConfig.get(`shortcuts.global.${command}`);
		return binding ? keyBindingToLabel(binding, os.isApple) : '';
	}
	return getShortcutDisplayLabel(settings.get(`shortcut.${command}`));
}
