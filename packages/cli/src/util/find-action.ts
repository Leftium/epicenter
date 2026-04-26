/**
 * Resolve a dotted action path against a workspace's action tree.
 *
 * Walks segments directly — no full-tree traversal, no precomputed
 * index. Returns the callable `Action` so `run` can invoke it; for
 * metadata-only lookup (suggestions, listing) callers should reach for
 * `actionManifest()` from `@epicenter/workspace` instead.
 */

import { type Action, isAction } from '@epicenter/workspace';

export function findAction(
	actions: unknown,
	path: string,
): Action | undefined {
	let target: unknown = actions;
	for (const segment of path.split('.')) {
		if (target == null || typeof target !== 'object') return undefined;
		target = (target as Record<string, unknown>)[segment];
	}
	return isAction(target) ? target : undefined;
}
