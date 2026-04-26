/**
 * Walk an action tree, return a flat manifest keyed by dot-path.
 *
 * Each entry IS an `ActionMeta` (same shape as the local-side metadata, see
 * `actions.ts`). The wire form and the local form are intentionally one
 * type so a single renderer or schema-builder can consume either source
 * without conversion.
 *
 * The manifest is plain JSON-bearing — TypeBox `TSchema` IS valid JSON
 * Schema by construction, so the action's `input` schema travels as-is.
 * Used by every device's bootstrap to publish offers into Yjs awareness
 * (`device.offers`) for cross-device action discovery.
 */

import { type ActionMeta, type Actions, isAction } from './actions.js';

export type ActionManifest = Record<string, ActionMeta>;

/** Walk an action tree, return a flat dot-path → ActionMeta map. */
export function actionManifest(actions: Actions): ActionManifest {
	const out: ActionManifest = {};
	walk(actions, [], out);
	return out;
}

function walk(node: Actions, path: string[], out: ActionManifest): void {
	for (const [key, value] of Object.entries(node)) {
		const childPath = [...path, key];
		if (isAction(value)) {
			const entry: ActionMeta = { type: value.type };
			if (value.input !== undefined) entry.input = value.input;
			if (value.title !== undefined) entry.title = value.title;
			if (value.description !== undefined) entry.description = value.description;
			out[childPath.join('.')] = entry;
		} else if (value != null && typeof value === 'object') {
			walk(value as Actions, childPath, out);
		}
	}
}
