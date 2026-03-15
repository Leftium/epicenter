/**
 * Bridge between workspace actions and command palette items.
 *
 * Walks the action tree via {@link iterateActions} and produces a flat array
 * of objects structurally compatible with `CommandPaletteItem` from `@epicenter/ui`.
 * No import from the UI package—TypeScript structural typing handles compatibility.
 *
 * Actions that require input are skipped by default since the palette has no
 * inline form. Pass a custom `filter` to override.
 *
 * @example
 * ```typescript
 * import { commandsFromActions } from '@epicenter/workspace';
 * import type { CommandPaletteItem } from '@epicenter/ui/command-palette';
 *
 * const commands: CommandPaletteItem[] = commandsFromActions(client.actions, {
 *   getGroup: ([namespace]) => namespace,
 * });
 * ```
 *
 * @module
 */

import { type Action, type Actions, iterateActions } from './actions.js';

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
 * @param options - Optional overrides for filtering and grouping
 * @returns Flat array structurally compatible with `CommandPaletteItem`
 */
export function commandsFromActions(
	actions: Actions,
	options?: {
		/** Return `false` to exclude an action. Defaults to skipping actions with input schemas. */
		filter?: (action: Action, path: string[]) => boolean;
		/** Map an action's path to a group heading. Defaults to the first path segment. */
		getGroup?: (path: string[]) => string | undefined;
	},
) {
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
		const include = options?.filter
			? options.filter(action, path)
			: !action.input;
		if (!include) continue;

		commands.push({
			id: path.join('.'),
			label: action.title ?? path[path.length - 1] ?? '',
			description: action.description,
			group: options?.getGroup?.(path) ?? path[0],
			destructive: action.destructive,
			keywords: path,
			onSelect() {
				action();
			},
		});
	}

	return commands;
}
