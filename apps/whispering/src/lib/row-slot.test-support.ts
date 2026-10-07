/**
 * The one row editor the library keeps for a row file, as a test expects to
 * find it, and typing into its controls as the row views do. Kept apart from
 * `workspace.test-support.ts`, which the host's tests also load, so the host's
 * type check never reaches the page's library.
 */
import type { CanonicalValue } from '@epicenter/folder';
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

/** Textareas report LF. */
const lf = (text: string) => text.replace(/\r\n?/g, '\n');

/** Type into a field's control: the valid row as it is now, with this field. */
export function typeField<TFields>(
	editing: RowEditing<TFields>,
	key: string,
	value: CanonicalValue,
) {
	const row = editing.row;
	if (row.status !== 'valid') return undefined;
	return editing.set(
		{ ...row, fields: { ...row.fields, [key]: value } },
		{ control: { field: key } },
	);
}

/** Type into the body's textarea, in LF: the valid row as it is now, with this body. */
export function typeBody<TFields>(editing: RowEditing<TFields>, typed: string) {
	const row = editing.row;
	if (row.status !== 'valid') return undefined;
	return editing.set({ ...row, body: typed }, { control: 'body' });
}

/** What a field's text control shows: what was typed there and not taken, else the valid row's string. */
export function fieldShown<TFields>(
	editing: RowEditing<TFields>,
	key: string,
): string {
	const held = editing.held.fields.get(key);
	if (held !== undefined) return held.value;
	const value =
		editing.row.status === 'valid' ? editing.row.fields[key] : undefined;
	return typeof value === 'string' ? value : '';
}

/** What the body's textarea shows, in LF: what was typed there and not taken, else the valid row's. */
export function bodyShown<TFields>(editing: RowEditing<TFields>): string {
	if (editing.held.body !== undefined) return editing.held.body.value;
	return editing.row.status === 'valid' ? lf(editing.row.body) : '';
}

/** What the source textarea shows: the whole text, in LF. */
export const sourceShown = <TFields>(editing: RowEditing<TFields>) =>
	lf(editing.row.text);
