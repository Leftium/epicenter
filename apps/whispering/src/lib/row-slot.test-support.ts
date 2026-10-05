/**
 * The one row editor the library keeps for a row file, as a test expects to
 * find it. Kept apart from `workspace.test-support.ts`, which the host's tests
 * also load, so the host's type check never reaches the page's library.
 */
import type { RowSlot } from './library.svelte.js';
import type { RowEditing } from './row-editing.svelte.js';

/** The editor a slot holds, once the row's editor is open. */
export function editingOf<TFields>(
	slot: RowSlot<TFields> | undefined,
): RowEditing<TFields> {
	if (slot?.kind !== 'open')
		throw new Error(`Expected the row's editor open, got ${slot?.kind}`);
	return slot.editing;
}

/** A row editor whose fields a test reads as plain values. */
export const untyped = <TFields>(editing: RowEditing<TFields>) =>
	editing as unknown as RowEditing<Record<string, unknown>>;
