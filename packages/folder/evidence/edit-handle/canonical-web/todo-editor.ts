/**
 * The demo's names for the todos row editor, shared by the three framework
 * views and the status panel: types, the complete rows structured controls
 * submit, textarea newlines, and the text a person reads.
 */
import type {
	CanonicalDocument,
	CanonicalValue,
	RowEditor,
	RowEditorState,
	RowError,
	RowSaveError,
	RowState,
	SaveState,
	TableEditError,
	TableReadError,
} from '../../../src/browser.js';
import { withFileNewlines } from '../../../src/file-browser.js';
import type { TodoRow } from './todos.js';

export type TodoEditor = RowEditor<TodoRow>;
export type TodoState = RowEditorState<TodoRow>;
export type TodoRowState = RowState<TodoRow>;
export type ValidTodo = Extract<TodoRowState, { status: 'valid' }>;

/**
 * Whether one view shows a valid row as Markdown source. The owner keeps
 * one per view per editor, so a view mounted again starts where it left
 * off, and no view reads or changes another's. An invalid row is always
 * shown as source.
 */
export type Presentation = { raw: boolean };

/** Textareas report LF, so views show LF and setters restore the file's convention. */
export const lf = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * The complete row a structured control submits: every field of the latest
 * valid row, with `key` replaced, or omitted when `value` is `undefined`,
 * and that row's body. Omitted keys are deleted, and unknown keys stay only
 * because they are in `row.fields`; the editor merges nothing.
 */
export function withField(
	row: ValidTodo,
	key: string,
	value: CanonicalValue | undefined,
): CanonicalDocument {
	const fields = Object.fromEntries(
		Object.entries(row.fields).filter(([name]) => name !== key),
	);
	if (value !== undefined) fields[key] = value;
	return { fields, body: row.body };
}

/** The complete row with a body typed in a textarea, in the body's own line endings. */
export function withBody(row: ValidTodo, typed: string): CanonicalDocument {
	return { fields: row.fields, body: withFileNewlines(typed, row.body) };
}

/** The latest valid row's values for the structured controls. */
export function controlsOf(row: ValidTodo) {
	return {
		title: row.fields.title,
		done: row.fields.done,
		/** `''` when the row has no priority. A valid row always has one. */
		priority: row.fields.priority ?? '',
		body: lf(row.body),
	};
}

/** Why readable text has no structured form. */
export function describeRowError(error: RowError): string {
	switch (error.name) {
		case 'Nonconforming':
			return `Not a valid todo: ${error.reading.issues
				.map((issue) => `${issue.field}: ${issue.message}`)
				.join('; ')}`;
		case 'NoCanonicalForm':
			return `No structured form: ${error.refusal.reason}`;
		case 'Unencodable':
			return 'The text has a lone surrogate, which UTF-8 cannot hold exactly. It is kept here and not written.';
		default:
			return error satisfies never;
	}
}

/** What the source view says above readable text: why it has no structured form, if it has none. */
export function sourceIssue(row: TodoRowState): string {
	return row.status === 'invalid' ? describeRowError(row.error) : '';
}

/** Why reading the row again failed. The input and its save state stay as they were. */
export function describeReadError(error: TableReadError): string {
	switch (error.name) {
		case 'NotFound':
			return 'The file is gone. The input is kept, and saving never creates the file again.';
		case 'InvalidUtf8':
			return 'The file is not UTF-8 text, so the input is kept.';
		default:
			return `The file cannot be read: ${error.message}`;
	}
}

export function describeSaveError(error: RowSaveError): string {
	switch (error.name) {
		case 'NotFound':
			return 'Not saved: the file is gone, and saving never creates it again.';
		case 'Unconfirmed':
			return `Saving could not be confirmed: ${error.message}`;
		case 'Unencodable':
			return 'Not saved: the text has a lone surrogate, so nothing was written.';
		default:
			return `Not saved: ${error.message}`;
	}
}

/** The save state in a few words, for each view. */
export function saveLabel(save: SaveState): string {
	switch (save.status) {
		case 'idle':
			return 'Saved';
		case 'saving':
			return 'Saving…';
		case 'failed':
			return describeSaveError(save.error);
		default:
			return save satisfies never;
	}
}

export function describeSave(save: SaveState): string {
	switch (save.status) {
		case 'idle':
			return 'Saved: no write is running or waiting.';
		case 'saving':
			return 'Saving: a write is running, and the latest input waits behind it.';
		case 'failed':
			return `${describeSaveError(save.error)} The input is kept, and nothing is written, newer input included, until "Save this text again". "Read the file again" discards it.`;
		default:
			return save satisfies never;
	}
}

/** Why `table.edit` returned no editor. */
export function describeOpenError(error: TableEditError): string {
	switch (error.name) {
		case 'NotFound':
			return 'There is no file here. Opening creates nothing; another caller has to write one first.';
		case 'InvalidUtf8':
			return 'The file is not UTF-8 text, so there is no text to edit.';
		case 'InvalidPath':
			return `This address is not a row of this folder: ${error.message}`;
		case 'Aborted':
			return 'Opening was cancelled.';
		default:
			return `The file could not be read: ${error.message}`;
	}
}
