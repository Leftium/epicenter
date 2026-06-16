import type { AnyTaggedError } from 'wellcrafted/error';
import { type Command, commands } from '$lib/commands';
import { report } from '$lib/report';
import type { Shortcuts } from './types';

/** A command paired with its current stored binding (`null` = unbound). */
export type ShortcutEntry<TBinding> = {
	command: Command;
	binding: TBinding | null;
};

/**
 * Per-platform binding adapter. The two shortcut backends (browser in-app KV,
 * desktop rdev device-config) differ only in where a binding is stored, how it
 * is formatted, and how it is pushed to the runtime. Everything around that
 * (sync orchestration, reset, label dispatch) is identical and lives in
 * {@link createShortcuts}, so each backend supplies just these primitives.
 */
export type ShortcutBackend<TBinding> = {
	/** This command's currently stored binding (`null` = unbound). */
	read(commandId: Command['id']): TBinding | null;
	/** This command's default binding (`null` = unbound by default). */
	getDefault(commandId: Command['id']): TBinding | null;
	/** Persist a binding for this command. */
	write(commandId: Command['id'], binding: TBinding | null): void;
	/** Format a binding for display (`''` when unbound). */
	label(binding: TBinding | null): string;
	/**
	 * Push the full set of current bindings to the platform runtime. Returns the
	 * error to surface, or `null` on success.
	 */
	push(entries: ShortcutEntry<TBinding>[]): Promise<AnyTaggedError | null>;
	/** Toast title when a push fails. */
	syncErrorTitle: string;
};

/**
 * Build the platform-agnostic `Shortcuts` surface over a {@link ShortcutBackend}.
 * The browser and desktop backends are otherwise structural twins; this is their
 * single source for sync, reset, and the default/current label dispatch.
 */
export function createShortcuts<TBinding>(
	backend: ShortcutBackend<TBinding>,
): Shortcuts {
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
		defaultLabel: (id) => backend.label(backend.getDefault(id)),
		currentLabel: (id) => backend.label(backend.read(id)),
	};
}
