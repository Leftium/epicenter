/**
 * Bridge between workspace actions and command palette items.
 *
 * Walks the action tree via {@link iterateActions} and produces a flat array
 * of objects structurally compatible with `CommandPaletteItem` from `@epicenter/ui`.
 * No import from the UI package—TypeScript structural typing handles compatibility.
 * Actions that require input are skipped since the palette has no inline form.
 *
 * @example
 * ```typescript
 * import { commandsFromActions } from '@epicenter/workspace';
 * import type { CommandPaletteItem } from '@epicenter/ui/command-palette';
 *
 * const commands: CommandPaletteItem[] = commandsFromActions(client.actions);
 * ```
 *
 * @module
 */

import { type Actions, iterateActions } from './actions.js';

/**
 * Convert a workspace action tree into an array of command palette items.
 *
 * Each yielded action becomes one command. The `path` array (e.g. `['posts', 'create']`)
 * is available for grouping and keyword generation.
 *
 * The return type is structurally compatible with `CommandPaletteItem` from `@epicenter/ui`.
 * Icons are omitted—add them at the app level where icon components are available.
 *
 * @param actions - The action tree from `workspaceClient.actions`
 * @returns Flat array structurally compatible with `CommandPaletteItem`
 */
export function commandsFromActions(actions: Actions) {
	const commands: {
		id: string;
		label: string;
		description?: string;
		group?: string;
		destructive?: boolean;
		keywords: string[];
		onSelect: () => void;
	}[] = [];

	for (const [action, path] of iterateActions(actions)) {
		if (action.input) continue;

		commands.push({
			id: path.join('.'),
			label: action.title ?? path[path.length - 1] ?? '',
			description: action.description,
			group: path[0],
			destructive: action.destructive,
			keywords: path,
			onSelect() {
				action();
			},
		});
	}

	return commands;
}
