/**
 * Walk a workspace's action tree producing dot-paths.
 *
 * The CLI dispatches against the user's `actions` object directly — no
 * precomputed index, no brand check. The tree is a nested object whose
 * leaves are `Action` (queries and mutations); intermediate nodes are
 * plain objects.
 */

import type { Action } from '@epicenter/workspace';
import { isAction } from '@epicenter/workspace';

export function* walkActions(
	actions: unknown,
	prefix: string[] = [],
): Iterable<[path: string, action: Action]> {
	if (actions == null || typeof actions !== 'object') return;
	for (const [key, value] of Object.entries(actions)) {
		const path = [...prefix, key];
		if (isAction(value)) {
			yield [path.join('.'), value];
		} else if (typeof value === 'object' && value !== null) {
			yield* walkActions(value, path);
		}
	}
}

export function findAction(actions: unknown, path: string): Action | undefined {
	for (const [p, action] of walkActions(actions)) {
		if (p === path) return action;
	}
	return undefined;
}

export function actionsUnder(
	actions: unknown,
	prefix: string,
): [string, Action][] {
	if (!prefix) return [...walkActions(actions)];
	const pfx = prefix + '.';
	const out: [string, Action][] = [];
	for (const [path, action] of walkActions(actions)) {
		if (path === prefix || path.startsWith(pfx)) out.push([path, action]);
	}
	return out;
}
