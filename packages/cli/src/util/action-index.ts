/**
 * Flat dot-path index of every branded action reachable from a document
 * handle. Built once at config load via `iterateActions`; the CLI's
 * `list` and `run` commands consult this index instead of walking the
 * handle themselves.
 *
 * Why the index instead of walking the handle each time:
 *   - the handle is a spread of the bundle (ydoc, tables, sync, user
 *     actions, …); walking it directly mixes framework internals into
 *     the path namespace, so `epicenter run ydoc` would route to a
 *     Y.Doc and emit a confusing error;
 *   - `list`, `run`, and sibling suggestions all want the same data;
 *     the index is the canonical source.
 *
 * The index is a `ReadonlyMap<string, Action>` plus `under(prefix)` —
 * every `[path, action]` at or under `prefix` (empty prefix returns all).
 */

import type { Action } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';

export type ActionIndex = ReadonlyMap<string, Action> & {
	under(prefix: string): Array<[string, Action]>;
};

export function buildActionIndex(handle: unknown): ActionIndex {
	const map = new Map<string, Action>();
	if (handle != null && typeof handle === 'object') {
		for (const [action, path] of iterateActions(handle)) {
			map.set(path.join('.'), action);
		}
	}

	function under(prefix: string): Array<[string, Action]> {
		if (!prefix) return [...map.entries()];
		const pfx = prefix + '.';
		const out: Array<[string, Action]> = [];
		for (const [k, v] of map) {
			if (k === prefix || k.startsWith(pfx)) out.push([k, v]);
		}
		return out;
	}

	return Object.assign(map, { under });
}
