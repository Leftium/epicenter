/**
 * The one draft the library keeps for a row file, as a test expects to find
 * it. Kept apart from `workspace.test-support.ts`, which the host's tests
 * also load, so the host's type check never reaches the page's library.
 */
import type { TextFileEditor } from './editor.svelte.js';
import type { RowSlot } from './library.svelte.js';
import type { RowDraft } from './row-draft.svelte.js';

/** The folder's row editor a slot holds, when the row opened as fields. */
export function formOf<TFields>(
	slot: RowSlot<TFields> | undefined,
): RowDraft<TFields> {
	if (slot?.kind !== 'form')
		throw new Error(`Expected the row open as fields, got ${slot?.kind}`);
	return slot.draft;
}

/** The text a slot holds, when the row is edited as its text. */
export function textOf(slot: RowSlot<unknown> | undefined): TextFileEditor {
	if (slot?.kind !== 'raw')
		throw new Error(`Expected the row open as text, got ${slot?.kind}`);
	return slot.editor;
}
