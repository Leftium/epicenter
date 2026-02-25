/**
 * Utility types for extracting statically-typed action names from a workspace.
 *
 * Given an `Actions` tree, `ActionNames` recursively walks the structure and
 * produces a string literal union of all tool names (e.g. `"tabs_search" | "tabs_list" | ...`).
 *
 * @module
 */

import type { Action, Actions } from '@epicenter/hq';

/** Separator used to join action path segments into tool names. */
export const ACTION_NAME_SEPARATOR = '_';

/**
 * Recursively extract all tool names from an `Actions` tree as a string literal union.
 *
 * Leaf `Action` nodes produce their key directly. Nested `Actions` objects
 * produce `"parent_child"` paths joined with `_`.
 *
 * @example
 * ```ts
 * type Names = ActionNames<typeof workspace.actions>;
 * // "tabs_search" | "tabs_list" | "tabs_close" | "windows_list" | ...
 * ```
 */
export type ActionNames<T extends Actions> = {
	[K in keyof T & string]: T[K] extends Action
		? K
		: T[K] extends Actions
			? `${K}_${ActionNames<T[K]>}`
			: never;
}[keyof T & string];
