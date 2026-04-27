/**
 * Walk a local action tree into a flat dot-path → `ActionMeta` map.
 *
 * Mirrors the workspace's internal `collectActionManifest` walker, kept in
 * the CLI for local-only callers (`list` self-source, `run` not-found
 * suggestions). Remote enumeration goes through
 * `peerSystem(sync, deviceId).describe()` instead.
 */

import type { ActionManifest, ActionMeta, Actions } from '@epicenter/workspace';
import type { TSchema } from 'typebox';

export function collectLocalManifest(actions: Actions): ActionManifest {
	const out: ActionManifest = {};
	walk(actions, [], out);
	return out;
}

function walk(node: Actions, path: string[], out: ActionManifest): void {
	for (const [key, value] of Object.entries(node)) {
		const childPath = [...path, key];
		if (
			typeof value === 'function' &&
			'type' in value &&
			(value.type === 'query' || value.type === 'mutation')
		) {
			const action = value as ActionMeta & { input?: TSchema };
			const entry: ActionMeta = { type: action.type };
			if (action.input !== undefined) entry.input = action.input;
			if (action.title !== undefined) entry.title = action.title;
			if (action.description !== undefined)
				entry.description = action.description;
			out[childPath.join('.')] = entry;
		} else if (value != null && typeof value === 'object') {
			walk(value as Actions, childPath, out);
		}
	}
}
