/**
 * How this window edits one recording, transcript, or transformation file:
 * the folder's row editor (`table.edit`), and the little the app adds over it.
 *
 * The row editor owns the row. What the person types is its input as soon as
 * they type it, valid or not, and one write at a time saves the latest input
 * over the file. A write that failed, or whose reply never arrived, keeps the
 * input and error on screen. New input saves again; Save again resubmits
 * the current input. The editor never reads the file again on its own: a change made
 * elsewhere shows only when the person reloads, and otherwise the next save
 * writes over it. A file that is gone is never created again.
 *
 * This adds:
 *
 * - Whether the path shows its fields or its source. It is the path's
 *   preference, kept across views; a row that is not valid shows its source.
 * - When input is taken: not while the library holds the path (a move, a
 *   deletion, or a close being decided), not while a reload the person asked
 *   for reads the file, and never once the row is put down.
 * - Why the last row typed in the fields was not taken. The codec refuses
 *   only a string with a lone surrogate, which a paste can carry. Nothing
 *   typed is kept: the row stays as it was and its controls show it. Only
 *   why is kept, beside the save's own status, until a row or text is
 *   taken, a reload takes the file, or the row is put down. It is not
 *   unsaved work and holds nothing up.
 * - One line of save status, most pressing first.
 *
 * The library's lists catch up with a save from the folder's change hint,
 * not from here.
 */
import type {
	CanonicalDocument,
	RowEditor,
	RowError,
	RowReloadError,
	RowSaveError,
	RowSetError,
} from '@epicenter/folder';
import { withFileNewlines } from '@epicenter/folder/file-browser';
import { fromRowEditor } from '@epicenter/folder/svelte';
import type { Result } from 'wellcrafted/result';
import type { Admits } from './editor.svelte.js';

/** Which view takes input: the row's fields, its whole text, or none once put down. */
export type RowView = 'fields' | 'source' | 'released';

/** One line about an open row's save, most pressing first. */
export type RowStatus =
	| { readonly kind: 'saved' }
	| { readonly kind: 'saving' }
	/** The latest write failed, its reply never arrived, or the file is gone. The input stays. */
	| {
			readonly kind: 'failed' | 'unconfirmed' | 'removed';
			readonly message: string;
	  }
	/** The text is saved and does not read as a valid row. */
	| { readonly kind: 'invalid'; readonly message: string };

const CLOSING =
	'Nothing was changed: this file is being moved or deleted, or Whispering is deciding whether to close.';
const RELEASED = 'This file is no longer open here, so nothing was changed.';

/** Why the codec refused a typed row, in the words the person is shown. */
const refusalReason = (reason: string) =>
	reason.includes('lone surrogate')
		? 'it has a character a file cannot hold exactly (a lone surrogate)'
		: reason;

/** Why readable text has no fields view, in the words the person is shown. */
export function describeRowError(error: RowError): string {
	switch (error.name) {
		case 'Nonconforming':
			return error.reading.issues
				.map((issue) => `${issue.field}: ${issue.message}`)
				.join('; ');
		case 'NoCanonicalForm':
			return `its text has no form the fields can be saved in: ${error.refusal.reason}`;
		case 'Unencodable':
			return 'its text has a lone surrogate, which a file cannot hold exactly, so it is not written';
		default:
			return error satisfies never;
	}
}

/** Why the save stopped, in the words the person is shown. */
function saveProblem(error: RowSaveError): RowStatus {
	if (error.name === 'NotFound')
		return {
			kind: 'removed',
			message:
				'This file is no longer in the folder, and saving never creates it again',
		};
	return {
		kind: error.name === 'Unconfirmed' ? 'unconfirmed' : 'failed',
		message: error.message,
	};
}

export function createRowEditing<TFields>(
	native: RowEditor<TFields>,
	{
		path,
		admits,
	}: {
		path: string;
		/** Whether the library takes the person's input and actions for this path now. */
		admits: Admits;
	},
) {
	const editor = fromRowEditor(native);
	let source = $state(false);
	let released = $state(false);
	/** Reloads the person asked for that are still reading the file. */
	let reloads = $state(0);
	/** Why the last row typed was not taken; see the module comment. */
	let refusal = $state.raw<{ readonly reason: string } | undefined>(undefined);

	const takes = () => !released && reloads === 0 && admits();

	function view(): RowView {
		if (released) return 'released';
		return source || editor.row.status === 'invalid' ? 'source' : 'fields';
	}

	return {
		path,
		/** The editor's row: valid, or invalid with why. Always the latest input. */
		get row() {
			return editor.row;
		},
		/** The editor's publication: idle, saving, or failed. */
		get save() {
			return editor.save;
		},
		get view(): RowView {
			return view();
		},
		/**
		 * Whether input is taken now, by the same rule every setter applies; a
		 * view shows its controls read-only while it is not. Each setter's own
		 * view rules (fields or source, a valid row) still apply.
		 */
		get editable() {
			return takes();
		},
		/** Whether a reload the person asked for is reading the file; input waits for it. */
		get reloading() {
			return reloads > 0;
		},
		get status(): RowStatus {
			if (editor.save.status === 'saving') return { kind: 'saving' };
			if (editor.save.status === 'failed')
				return saveProblem(editor.save.error);
			if (editor.row.status === 'invalid')
				return { kind: 'invalid', message: describeRowError(editor.row.error) };
			return { kind: 'saved' };
		},
		/**
		 * Why the last row typed was not taken, in the words the person is
		 * shown, or `undefined`. What was typed is not kept; the row and its
		 * controls show the input taken before it.
		 */
		get refusal() {
			return refusal;
		},
		/** Whether leaving would lose something: a write still running, or one that stopped. */
		get holds() {
			return !released && editor.save.status !== 'idle';
		},
		/**
		 * Set a complete row: every field to keep, and the body, exactly as
		 * given. Omitted fields are deleted. Taken only while the fields are the
		 * view of a valid row; otherwise nothing changes and this returns
		 * `undefined`. A row the codec refuses changes nothing; only why is
		 * kept, until input is taken.
		 */
		set(next: CanonicalDocument): Result<undefined, RowSetError> | undefined {
			if (!takes() || source || editor.row.status !== 'valid') return undefined;
			const result = editor.set(next);
			refusal =
				result.error === null
					? undefined
					: { reason: refusalReason(result.error.refusal.reason) };
			return result;
		},
		/** Set the whole text, typed in the source textarea, in the file's own line endings. */
		setText(typed: string) {
			if (!takes() || view() !== 'source') return;
			native.setText(withFileNewlines(typed, native.get().row.text));
			refusal = undefined;
			// Typing here keeps the source shown after the text becomes a valid row.
			source = true;
		},
		/** Show the source, or the fields. Fields are shown only for a valid row. */
		showSource(next: boolean): string | undefined {
			if (released) return RELEASED;
			if (!admits()) return CLOSING;
			const { row } = native.get();
			if (!next && row.status === 'invalid')
				return `This file still cannot be edited as fields: ${describeRowError(row.error)}.`;
			source = next;
			return undefined;
		},
		/** Save the latest input again after a write failed or was never answered. */
		retry(): string | undefined {
			if (released) return RELEASED;
			if (!takes()) return CLOSING;
			native.retry();
			return undefined;
		},
		/**
		 * Take the file as it is now, as the person asked: running writes
		 * settle, then the file is read and replaces the input, and a stopped
		 * save and a refusal are let go. Input is not taken meanwhile. A read
		 * that fails changes nothing.
		 */
		async reload(): Promise<Result<undefined, RowReloadError>> {
			reloads += 1;
			try {
				const reloaded = await native.reload();
				if (reloaded.error === null) refusal = undefined;
				return reloaded;
			} finally {
				reloads -= 1;
			}
		},
		/** Wait for the writes already admitted. Never saves anything again. */
		waitForSaves: native.waitForSaves,
		/**
		 * Put the row down: it takes no input. A write already admitted still
		 * settles in the editor.
		 */
		release() {
			if (released) return;
			released = true;
			refusal = undefined;
		},
	};
}

export type RowEditing<TFields> = ReturnType<typeof createRowEditing<TFields>>;
