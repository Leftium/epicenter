/**
 * Walk an action tree, return a flat manifest keyed by dot-path.
 *
 * Used by the peer dispatch layer to publish a device's offers into Yjs
 * awareness so other peers can discover what actions this device handles.
 *
 * The manifest is a plain JSON-bearing object — fully serializable, safe to
 * put on the awareness wire. TypeBox schemas are JSON Schema by construction
 * (the `TSchema` shape IS a valid JSON Schema document), so the action's
 * `input` schema is included directly without conversion. Consumers (e.g. a
 * mobile UI building a form for a remote action) get the full input shape
 * without an additional fetch.
 */

import { type ActionMeta, type Actions, isAction } from './actions.js';

/**
 * One entry in the published action manifest. Structurally identical to
 * `ActionMeta` — the wire shape and the local-metadata shape are the same
 * type, so a single renderer can consume either source without conversion.
 *
 * The `input` schema travels as JSON (TypeBox `TSchema` IS valid JSON Schema
 * by construction), so consumers reading `device.offers` over awareness see
 * the exact same fields as a local `Action`'s metadata.
 */
export type ActionManifestEntry = ActionMeta;

export type ActionManifest = Record<string, ActionManifestEntry>;

/** Walk an action tree, return a flat dot-path → entry map. */
export function actionManifest(actions: Actions): ActionManifest {
	const out: ActionManifest = {};
	walk(actions, [], out);
	return out;
}

function walk(node: Actions, path: string[], out: ActionManifest): void {
	for (const [key, value] of Object.entries(node)) {
		const childPath = [...path, key];
		if (isAction(value)) {
			const entry: ActionManifestEntry = { type: value.type };
			if (value.input !== undefined) entry.input = value.input;
			if (value.title !== undefined) entry.title = value.title;
			if (value.description !== undefined) entry.description = value.description;
			out[childPath.join('.')] = entry;
		} else if (value != null && typeof value === 'object') {
			walk(value as Actions, childPath, out);
		}
	}
}
