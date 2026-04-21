/**
 * Walk a dotted path into a document bundle. The `root` passed in should be
 * the BUNDLE — the handle's prototype — because `iterateActions` and plain
 * property access via `Object.entries` skip the prototype chain.
 */

import type { Action } from '@epicenter/workspace';
import { isAction } from '@epicenter/workspace';

export type ResolvedPath =
	| { kind: 'action'; action: Action; path: string[] }
	| { kind: 'subtree'; node: unknown; path: string[] }
	| { kind: 'missing'; lastGoodPath: string[]; missingSegment: string };

export function resolvePath(root: unknown, segments: string[]): ResolvedPath {
	let node: unknown = root;
	const walked: string[] = [];
	for (const seg of segments) {
		if (node == null || typeof node !== 'object') {
			return { kind: 'missing', lastGoodPath: walked, missingSegment: seg };
		}
		const next = (node as Record<string, unknown>)[seg];
		if (next === undefined) {
			return { kind: 'missing', lastGoodPath: walked, missingSegment: seg };
		}
		walked.push(seg);
		node = next;
	}
	if (isAction(node)) return { kind: 'action', action: node, path: walked };
	return { kind: 'subtree', node, path: walked };
}
