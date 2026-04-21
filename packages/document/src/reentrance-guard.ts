/**
 * Reentrance guards for attach* primitives.
 *
 * Invariant: A live Y.Doc may have each primitive+slot attached at most once.
 * A second attach THROWS with a clear message. The guard is cleared on
 * `ydoc.destroy()`, so a fresh attach after destroy works.
 *
 * Storage:
 * - `perSlotGuards`: primitive => Y.Doc => Set<slot> for per-slot primitives
 *   (attachTable, attachPlainText, attachRichText).
 * - `singletonGuards`: primitive => WeakSet<Y.Doc> for singletons
 *   (attachKv, attachAwareness, attachEncryption).
 *
 * Destroy listener: a single `ydoc.on('destroy')` per (ydoc, primitive, slot)
 * (or singleton) path clears the guard entry. We register at most one
 * listener per (ydoc, primitive) pair to avoid accumulating handlers.
 *
 * Not part of the public API — exported from `@epicenter/document/internal`
 * so `@epicenter/workspace` can reuse the same helpers.
 *
 * @module
 */

import type * as Y from 'yjs';

const perSlotGuards = new Map<string, WeakMap<Y.Doc, Set<string>>>();
const singletonGuards = new Map<string, WeakSet<Y.Doc>>();

function getPerSlotMap(primitive: string): WeakMap<Y.Doc, Set<string>> {
	let map = perSlotGuards.get(primitive);
	if (map === undefined) {
		map = new WeakMap();
		perSlotGuards.set(primitive, map);
	}
	return map;
}

function getSingletonSet(primitive: string): WeakSet<Y.Doc> {
	let set = singletonGuards.get(primitive);
	if (set === undefined) {
		set = new WeakSet();
		singletonGuards.set(primitive, set);
	}
	return set;
}

/**
 * Guard a per-slot primitive (e.g. `attachTable`, `attachPlainText`,
 * `attachRichText`). Throws if `(ydoc, primitive, slot)` is already attached.
 *
 * Error message names both the primitive and the slot so the call site is
 * obvious in a stack trace.
 */
export function guardSlot(
	ydoc: Y.Doc,
	primitive: string,
	slot: string,
): void {
	const map = getPerSlotMap(primitive);
	let slots = map.get(ydoc);
	if (slots === undefined) {
		slots = new Set();
		map.set(ydoc, slots);
		ydoc.on('destroy', () => {
			map.delete(ydoc);
		});
	}
	if (slots.has(slot)) {
		throw new Error(
			`${primitive}: slot '${slot}' is already attached to this Y.Doc. ` +
				`Each slot may be attached at most once per Y.Doc. ` +
				`Keep the reference from the first ${primitive} call — don't re-attach.`,
		);
	}
	slots.add(slot);
}

/**
 * Guard a singleton primitive (e.g. `attachKv`, `attachAwareness`,
 * `attachEncryption`). Throws if `(ydoc, primitive)` is already attached.
 */
export function guardSingleton(ydoc: Y.Doc, primitive: string): void {
	const set = getSingletonSet(primitive);
	if (set.has(ydoc)) {
		throw new Error(
			`${primitive}: this Y.Doc already has ${primitive} attached. ` +
				`Each Y.Doc may have at most one ${primitive} attachment. ` +
				`Keep the reference from the first call — don't re-attach.`,
		);
	}
	set.add(ydoc);
	ydoc.on('destroy', () => {
		set.delete(ydoc);
	});
}
