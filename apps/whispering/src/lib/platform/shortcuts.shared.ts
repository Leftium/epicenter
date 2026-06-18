import type { AnyTaggedError } from 'wellcrafted/error';
import { os } from '#platform/os';
import { type Command, commands } from '$lib/commands';
import { report } from '$lib/report';
import type { KeyBinding } from '$lib/tauri/commands';
import { keyBindingToLabel } from '$lib/utils/key-binding';
import type { Shortcuts } from './types';

/** A command paired with its current stored binding (`null` = unbound). */
export type ShortcutEntry = {
	command: Command;
	binding: KeyBinding | null;
};

/**
 * Per-platform binding adapter. Both shortcut backends now speak the same
 * physical `KeyBinding`; they differ only in where a binding is stored (browser
 * in-app KV vs desktop device-config) and how it is pushed to the runtime
 * (browser keydown matcher vs rdev/plugin). Everything around that (sync
 * orchestration, reset, label dispatch) is identical and lives in
 * {@link createShortcuts}, so each backend supplies just these primitives.
 */
export type ShortcutBackend = {
	/** This command's currently stored binding (`null` = unbound). */
	read(commandId: Command['id']): KeyBinding | null;
	/** This command's default binding (`null` = unbound by default). */
	getDefault(commandId: Command['id']): KeyBinding | null;
	/** Persist a binding for this command. */
	write(commandId: Command['id'], binding: KeyBinding | null): void;
	/**
	 * Push the full set of current bindings to the platform runtime. Returns the
	 * error to surface, or `null` on success.
	 */
	push(entries: ShortcutEntry[]): Promise<AnyTaggedError | null>;
	/** Toast title when a push fails. */
	syncErrorTitle: string;
};

/** Format a binding for display (`''` when unbound). Both tiers render the same. */
function label(binding: KeyBinding | null): string {
	return binding ? keyBindingToLabel(binding, os.isApple) : '';
}

/**
 * Build the platform-agnostic `Shortcuts` surface over a {@link ShortcutBackend}.
 * The browser and desktop backends are otherwise structural twins; this is their
 * single source for sync, reset, and the default/current label dispatch.
 */
export function createShortcuts(backend: ShortcutBackend): Shortcuts {
	async function sync(): Promise<void> {
		const entries = commands.map((command) => ({
			command,
			binding: backend.read(command.id),
		}));
		const error = await backend.push(entries);
		if (error) report.error({ title: backend.syncErrorTitle, cause: error });
	}

	function reset(): void {
		for (const command of commands) {
			backend.write(command.id, backend.getDefault(command.id));
		}
		void sync();
	}

	return {
		sync,
		reset,
		defaultLabel: (id) => label(backend.getDefault(id)),
		currentLabel: (id) => label(backend.read(id)),
	};
}
