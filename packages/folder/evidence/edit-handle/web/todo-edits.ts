/**
 * EXPERIMENT: the demo's names for a todo edit handle, shared by all three
 * framework callers. Types only, plus one message helper; no binding code.
 */
import type { PatchRefusal } from '../../../src/markdown.js';
import type { EditRefusal } from '../edit-handle.js';
import type { FolderEdits } from '../folder-edits.js';
import type { DemoFolder } from './folder-http.js';

export type TodoEdits = FolderEdits<DemoFolder['tables']>;
export type TodoEdit = ReturnType<TodoEdits['tables']['todos']['edit']>;
export type TodoState = ReturnType<TodoEdit['get']>;
export type TodoSnapshot = TodoState['baseline'];
export type Priority = NonNullable<TodoState['reading']['fields']['priority']>;

/** What a person is told when a control's change was not applied. */
export function describeRefusal(refusal: PatchRefusal | EditRefusal): string {
	switch (refusal.kind) {
		case 'unparsed':
			return `Not applied: the draft source does not parse (${refusal.error.message}). Fix it in the raw source.`;
		case 'unsafe':
			return `Not applied: this source cannot take the change safely (${refusal.reason}).`;
		case 'value':
			return `Not applied: ${refusal.field} cannot be written (${refusal.reason}).`;
		case 'refused':
			return `Not applied: ${REFUSED[refusal.reason]}.`;
	}
}

const REFUSED = {
	disposed: 'this handle was disposed',
	saving: 'a save is in flight and cannot be cancelled',
	otherPath: 'that snapshot is of another file',
} satisfies Record<EditRefusal['reason'], string>;
