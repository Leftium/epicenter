/**
 * Walk a document handle's action surface.
 *
 * `iterateActions` uses `Object.entries`, which does NOT traverse the
 * prototype chain. A `DocumentHandle` stores user-attached properties
 * (`tables`, `kv`, custom groups) on its bundle — exposed via
 * `Object.create(bundle)` — and only `dispose` / `[Symbol.dispose]` as own
 * properties. So we must hand the BUNDLE (the prototype) to `iterateActions`,
 * never the handle itself.
 */

import type {
	Action,
	Actions,
	DocumentBundle,
	DocumentHandle,
} from '@epicenter/workspace';
import { isAction, iterateActions } from '@epicenter/workspace';

export type DiscoveredAction = {
	/** Segments relative to the traversal root. */
	path: string[];
	action: Action;
};

/** Return the bundle that backs a handle (the handle's prototype). */
export function bundleOf(
	handle: DocumentHandle<DocumentBundle>,
): DocumentBundle {
	return Object.getPrototypeOf(handle) as DocumentBundle;
}

/**
 * Walk `root` recursively and collect every branded action with its path.
 * `root` should be a bundle or an object nested within one — never a raw
 * `DocumentHandle` (whose own keys are just disposers).
 */
export function discoverActions(root: unknown): DiscoveredAction[] {
	if (root == null || typeof root !== 'object') return [];
	const out: DiscoveredAction[] = [];
	for (const [action, path] of iterateActions(root as Actions)) {
		out.push({ action, path });
	}
	return out;
}

export type ResolvedPath =
	| { kind: 'action'; action: Action; path: string[] }
	| { kind: 'subtree'; node: unknown; path: string[] }
	| { kind: 'missing'; lastGoodPath: string[]; missingSegment: string };

/**
 * Walk `root` by dot-path segments. Returns the outcome discriminator so the
 * caller can pick between invoking, rendering a subtree, or producing a
 * "did you mean" error.
 */
export function resolvePath(root: unknown, segments: string[]): ResolvedPath {
	let node: unknown = root;
	const walked: string[] = [];
	for (const seg of segments) {
		if (node == null || typeof node !== 'object') {
			return {
				kind: 'missing',
				lastGoodPath: walked,
				missingSegment: seg,
			};
		}
		const next = (node as Record<string, unknown>)[seg];
		if (next === undefined) {
			return {
				kind: 'missing',
				lastGoodPath: walked,
				missingSegment: seg,
			};
		}
		walked.push(seg);
		node = next;
	}
	if (isAction(node)) {
		return { kind: 'action', action: node, path: walked };
	}
	return { kind: 'subtree', node, path: walked };
}
