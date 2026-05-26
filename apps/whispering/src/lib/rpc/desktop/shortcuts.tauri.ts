import { type Command, commandCallbacks } from '$lib/commands';
import { GlobalShortcutManagerLive } from '$lib/services/global-shortcut-manager';
import { IS_MACOS } from '$lib/constants/platform';
import { defineMutation } from '$lib/rpc/client';
// see direct imports below
import type { Accelerator } from '$lib/services/global-shortcut-manager';

/**
 * Global shortcuts - desktop-only, require Tauri.
 * These use system-level global shortcuts that work even when the app is not focused.
 */
export const globalShortcuts = {
	registerCommand: defineMutation({
		mutationKey: ['shortcuts', 'registerCommandGlobally'] as const,
		mutationFn: ({
			command,
			// Parameter renamed to indicate it may contain legacy "CommandOrControl" syntax
			// Legacy format: "CommandOrControl+Shift+R" → Modern format: "Command+Shift+R" (macOS) or "Control+Shift+R" (Windows/Linux)
			accelerator: legacyAcceleratorString,
		}: {
			command: Command;
			accelerator: Accelerator;
		}) => {
			// Convert legacy "CommandOrControl" syntax to platform-specific modifiers for backwards compatibility
			// This ensures users with old settings don't need to manually update their shortcuts
			const accelerator = legacyAcceleratorString.replace(
				'CommandOrControl',
				IS_MACOS ? 'Command' : 'Control',
			) as Accelerator;
			return GlobalShortcutManagerLive.register({
				accelerator,
				callback: commandCallbacks[command.id],
				on: command.on,
			});
		},
	}),

	unregisterCommand: defineMutation({
		mutationKey: ['shortcuts', 'unregisterCommandGlobally'] as const,
		mutationFn: async ({ accelerator }: { accelerator: Accelerator }) => {
			return await GlobalShortcutManagerLive.unregister(
				accelerator,
			);
		},
	}),

	unregisterAll: defineMutation({
		mutationKey: ['shortcuts', 'unregisterAllGlobalShortcuts'] as const,
		mutationFn: async () =>
			GlobalShortcutManagerLive.unregisterAll(),
	}),
};
