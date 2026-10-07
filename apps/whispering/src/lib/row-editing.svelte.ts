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
 * - A typed value the row cannot take. Each input is a complete row, named by
 *   the control it was typed in: a field or the body. The codec refuses only a
 *   string with a lone surrogate, which a paste can carry. The string typed is
 *   kept for its control, shown there to repair, and holds the close, until
 *   that control takes a value, the person discards it, or a reload takes the
 *   file. Others are kept meanwhile: a row that would change what a held
 *   control's row value is is refused unless it comes from that control, and
 *   the source is not shown over them. It is never a second copy of the row.
 * - One line of status, most pressing first.
 *
 * The library's lists catch up with a save from the folder's change hint,
 * not from here.
 */
import type {
	CanonicalDocument,
	CanonicalValue,
	RowEditor,
	RowError,
	RowReloadError,
	RowSaveError,
	RowSetError,
} from '@epicenter/folder';
import { withFileNewlines } from '@epicenter/folder/file-browser';
import { fromRowEditor } from '@epicenter/folder/svelte';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Admits } from './editor.svelte.js';

/** Which view takes input: the row's fields, its whole text, or none once put down. */
export type RowView = 'fields' | 'source' | 'released';

/** One line about an open row, most pressing first. */
export type RowStatus =
	| { readonly kind: 'saved' }
	| { readonly kind: 'saving' }
	/** The latest write failed, its reply never arrived, or the file is gone. The input stays. */
	| {
			readonly kind: 'failed' | 'unconfirmed' | 'removed';
			readonly message: string;
	  }
	/**
	 * Values typed in some controls have no form a file can hold. Each is kept
	 * in its control, not saved. `controls` names them: field names, or `body`.
	 */
	| {
			readonly kind: 'refused';
			readonly controls: readonly string[];
			readonly message: string;
	  }
	/** The text is saved and does not read as a valid row. */
	| { readonly kind: 'invalid'; readonly message: string };

const CLOSING =
	'Nothing was changed: this file is being moved or deleted, or Whispering is deciding whether to close.';
const RELEASED = 'This file is no longer open here, so nothing was changed.';

/** A typed value the row did not take, kept for the one control it was typed in. */
type Refused = {
	/** Exactly as typed, in LF for the body. */
	readonly value: string;
	readonly reason: string;
};

/** The typed values the row did not take, one at most per control. */
type Held = {
	readonly fields: ReadonlyMap<string, Refused>;
	readonly body: Refused | undefined;
};

const NONE: Held = Object.freeze({ fields: new Map(), body: undefined });

const SOURCE_HELD =
	'Fix or discard what you typed that cannot be saved first, so it is not hidden behind the source.';

/** The control a row was typed in: one field, or the body. */
type Control = { readonly field: string } | 'body';

const RowEditingError = defineErrors({
	/**
	 * `set` would change the row value of a control that holds a typed value
	 * the row could not take, and the row did not come from that control.
	 * Nothing changed.
	 */
	HeldInput: ({ path, control }: { path: string; control: string }) => ({
		message: `The row for '${path}' was not changed: ${control} holds typed text that cannot be saved yet`,
		path,
		control,
	}),
});
type HeldInputError = InferErrors<typeof RowEditingError>;

const isList = (value: CanonicalValue): value is readonly CanonicalValue[] =>
	Array.isArray(value);

/** Whether two field values are the same value; `undefined` is an absent field. */
function same(
	a: CanonicalValue | undefined,
	b: CanonicalValue | undefined,
): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
	if (isList(a) || isList(b))
		return (
			isList(a) &&
			isList(b) &&
			a.length === b.length &&
			a.every((item, index) => same(item, b[index]))
		);
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
	);
}

/** Why the codec refused a typed value, in the words the person is shown. */
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
	/** Typed values the row did not take, per control; see the module comment. */
	let held = $state.raw<Held>(NONE);

	const holding = () => held.fields.size > 0 || held.body !== undefined;

	/** Keep, or with `undefined` let go of, the value held for one control. */
	function hold(control: Control, value: Refused | undefined) {
		if (control === 'body') {
			if (held.body !== value) held = { ...held, body: value };
			return;
		}
		if (value === undefined && !held.fields.has(control.field)) return;
		const fields = new Map(held.fields);
		if (value === undefined) fields.delete(control.field);
		else fields.set(control.field, value);
		held = { ...held, fields };
	}

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
		/** Whether the path prefers its source to its fields. */
		get source() {
			return source;
		},
		get released() {
			return released;
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
			if (holding()) {
				const controls = [...held.fields.keys()];
				if (held.body !== undefined) controls.push('body');
				const first = held.fields.values().next().value ?? held.body;
				return {
					kind: 'refused',
					controls,
					message: first?.reason ?? '',
				};
			}
			if (editor.row.status === 'invalid')
				return { kind: 'invalid', message: describeRowError(editor.row.error) };
			return { kind: 'saved' };
		},
		/**
		 * Whether leaving would lose something: a write still running, one
		 * that stopped, or a typed value the row could not take.
		 */
		get holds() {
			return !released && (editor.save.status !== 'idle' || holding());
		},
		/**
		 * The typed values the row did not take, per control. A control shows
		 * its own over the valid row's value.
		 */
		get held(): Held {
			return held;
		},
		/**
		 * Set a complete row: every field to keep, and the body. Omitted fields
		 * are deleted. Taken only while the fields are the view of a valid row;
		 * otherwise nothing changes and this returns `undefined`.
		 *
		 * `control` names where it was typed. A body typed in a textarea is in
		 * LF and is saved in the body's own line endings; any other body is
		 * saved exactly. A row that changes what a held control's row value is
		 * is refused unless it comes from that control. When the row cannot be
		 * written, the string typed in `control` is kept for it; when it is
		 * taken, that control's held value is let go. A row from no control
		 * keeps and lets go of nothing.
		 */
		set(
			next: CanonicalDocument,
			{ control }: { control?: Control } = {},
		): Result<undefined, RowSetError | HeldInputError> | undefined {
			const row = editor.row;
			if (!takes() || source || row.status !== 'valid') return undefined;
			for (const key of held.fields.keys())
				if (
					(control === 'body' || control?.field !== key) &&
					!same(next.fields[key], row.fields[key])
				)
					return RowEditingError.HeldInput({ path, control: key });
			if (
				held.body !== undefined &&
				control !== 'body' &&
				next.body !== row.body
			)
				return RowEditingError.HeldInput({ path, control: 'body' });
			const result = editor.set({
				fields: next.fields,
				body:
					control === 'body'
						? withFileNewlines(next.body, row.body)
						: next.body,
			});
			if (control === undefined) return result;
			if (result.error === null) {
				hold(control, undefined);
				return result;
			}
			const typed = control === 'body' ? next.body : next.fields[control.field];
			if (typeof typed === 'string')
				hold(control, {
					value: typed,
					reason: refusalReason(result.error.refusal.reason),
				});
			return result;
		},
		/**
		 * Let go of the typed value one control holds, as the person asked: a
		 * field's name, or `body`. Every other control keeps its own.
		 */
		dropRefused(control: string) {
			if (control === 'body') hold('body', undefined);
			else hold({ field: control }, undefined);
		},
		/** Set the whole text, typed in the source textarea, in the file's own line endings. */
		setText(typed: string) {
			if (!takes() || view() !== 'source') return;
			native.setText(withFileNewlines(typed, native.get().row.text));
			// Typing here keeps the source shown after the text becomes a valid row.
			source = true;
		},
		/**
		 * Show the source, or the fields. Fields are shown only for a valid row,
		 * and the source is not shown while a field holds a typed value it could
		 * not take, which the source would hide.
		 */
		showSource(next: boolean): string | undefined {
			if (released) return RELEASED;
			if (!admits()) return CLOSING;
			if (next && holding()) return SOURCE_HELD;
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
		 * save and a refused typed value are let go. Input is not taken
		 * meanwhile. A read that fails changes nothing.
		 */
		async reload(): Promise<Result<undefined, RowReloadError>> {
			reloads += 1;
			try {
				const reloaded = await native.reload();
				if (reloaded.error === null) held = NONE;
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
			held = NONE;
		},
	};
}

export type RowEditing<TFields> = ReturnType<typeof createRowEditing<TFields>>;
