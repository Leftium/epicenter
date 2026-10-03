/**
 * The demo's names for the todos row editor, shared by all three framework
 * callers. Types plus the text a person reads.
 */
import type {
	RowChangeError,
	RowEditor,
	RowEditorState,
	RowSaveError,
} from '../../../src/browser.js';
import type { TodoRow } from './todos.js';

export type TodoEditor = RowEditor<TodoRow>;
export type TodoState = RowEditorState<TodoRow>;

/**
 * What the controls show: the draft document, not the validated
 * `reading.fields`, so a value that fails the schema (a one-letter title, a
 * removed priority) stays visible while it is being typed.
 */
export function draftOf({ document }: TodoState) {
	const { title, done, priority } = document.fields;
	return {
		title: typeof title === 'string' ? title : '',
		done: done === true,
		/** `''` when the draft has no priority: the field was removed. */
		priority: typeof priority === 'string' ? priority : '',
		body: document.body,
	};
}

export function describeChangeError(error: RowChangeError): string {
	return `Not applied: ${error.message}`;
}

export function describeSaveError(error: RowSaveError): string {
	switch (error.name) {
		case 'InvalidDocument':
			return 'Not saved: the draft has the issues listed above.';
		case 'Saving':
			return 'Not saved: a save is already running.';
		case 'Disposed':
			return 'Not saved: this editor is closed.';
		case 'Unconfirmed':
			return 'Unknown: the reply was lost, so the file may or may not hold this save.';
		default:
			return `Not saved: ${error.message}`;
	}
}
