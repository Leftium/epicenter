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
 * The index is a `ReadonlyMap<string, Action>` with two extras:
 *   - `under(prefix)` — every `[path, action]` at or under `prefix`
 *     (empty prefix returns everything);
 *   - `children(prefix)` — immediate sub-segment names at `prefix`.
 */

import type { Action } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';

export type ActionIndex = ReadonlyMap<string, Action> & {
	under(prefix: string): Array<[string, Action]>;
	children(prefix: string): string[];
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

	function children(prefix: string): string[] {
		const pfx = prefix ? prefix + '.' : '';
		const out = new Set<string>();
		for (const k of map.keys()) {
			if (prefix && !k.startsWith(pfx)) continue;
			const rest = prefix ? k.slice(pfx.length) : k;
			const head = rest.split('.')[0];
			if (head) out.add(head);
		}
		return [...out];
	}

	return Object.assign(map, { under, children });
}
