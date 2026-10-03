/**
 * EXPERIMENT: the demo's names for a todo canonical editor, shared by all
 * three framework callers. Types plus the text a person reads.
 */
import type {
	CanonicalEditor,
	ChangeError,
	SaveError,
} from '../canonical-editor.js';
import type { TodoRow } from './todos.js';

export type TodoEditor = CanonicalEditor<TodoRow>;
export type TodoState = ReturnType<TodoEditor['get']>;

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

export function describeChangeError(error: ChangeError): string {
	return `Not applied: ${error.message}`;
}

export function describeSaveError(error: SaveError): string {
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
