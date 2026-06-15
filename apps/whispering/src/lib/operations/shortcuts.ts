import type { Command } from '$lib/commands';
import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
import { services } from '$lib/services';
import type { CommandId } from '$lib/services/local-shortcut-manager';

/**
 * Local shortcuts - cross-platform, work in web and desktop.
 * These use browser keyboard events.
 */
export const localShortcuts = {
	registerCommand: ({
		command,
		keyCombination,
	}: {
		command: Command;
		keyCombination: KeyboardEventSupportedKey[];
	}) =>
		services.localShortcutManager.register({
			id: command.id as CommandId,
			keyCombination,
		}),

	unregisterCommand: async ({ commandId }: { commandId: CommandId }) =>
		services.localShortcutManager.unregister(commandId),
};
