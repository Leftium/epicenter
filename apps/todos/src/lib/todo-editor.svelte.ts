/**
 * The todo editor: one todo row's retained native row editor (`table.edit`)
 * and the few rules the app keeps around it.
 *
 * The native editor owns the row. Every field, notes, source, and checkbox
 * change is a complete replacement handed to `set` or `setText` at once; it
 * is the row the views show from then on and is written last-writer-wins
 * over the existing file, one write at a time with the latest input next.
 * A failed or unconfirmed write keeps the input and the error and pauses
 * writing until the person tries again (`retry`) or reloads the file over
 * their input (`reload`). The file is read when the editor opens and again
 * only on `reload`; nothing adopts another writer's change on its own.
 *
 * This module adds only:
 *
 * - The source preference. Fields and source are two views of the same row;
 *   a raw edit keeps the source view after the text becomes valid, until the
 *   person chooses Edit fields. It is view state, kept here so it outlives
 *   the views and follows a rename.
 * - Refused fields. A title or notes value the row cannot be written with
 *   (it has no canonical form) is accepted by nothing, so this editor keeps
 *   that one field's typed value and why, and the field shows it for
 *   correction. It is not a second row: the rest of the row stays the
 *   native editor's, other fields keep saving, and the next accepted value
 *   of that field clears it. Only a deliberate reload drops it.
 *   Until then it counts as unsaved input, so leaving, rename, delete,
 *   close, and a departure treat it as not settled.
 * - Fences. Rename, delete, a recovery of an incoming update, close, and a
 *   departure refuse input while they run; rename, delete, and close first
 *   wait for admitted writes and stop when one failed or a field is refused.
 * - Release. The owner (`todos.svelte.ts`) retains one editor per path and
 *   releases it when it forgets the path or a rename moves the row. A
 *   released editor refuses input and commands for good. An editor's path
 *   never changes.
 */
import type {
	CanonicalDocument,
	RowEditor,
	RowReloadError,
	RowSaveError,
} from '@epicenter/folder';
import { withFileNewlines } from '@epicenter/folder/file-browser';
import { fromRowEditor } from '@epicenter/folder/svelte';
import type { TodoFields } from './definition.js';

/** Textareas report LF, so views show LF and setters restore the file's convention. */
const lf = (text: string) => text.replace(/\r\n?/g, '\n');

/** Why an operation was refused because this editor is working on its file. */
export const BUSY =
	'Another change to this file is still in progress. Try again when it finishes.';

/** Why a released editor refused: the owner let it go, after a rename, delete, or close. */
export const RELEASED =
	'This todo is no longer open here, so nothing was changed. Open it again.';

/** Why input or a command was refused while Epicenter asks to quit or restart. */
export const DEPARTING =
	'Epicenter is asking to quit or restart, so nothing is changed now. Your edits are kept.';

/**
 * What a person is told about a stopped save. An unconfirmed save may have
 * landed; the folder's own message stays, since it can name where a
 * displaced file was kept.
 */
export function describeSaveError(error: RowSaveError): string {
	switch (error.name) {
		case 'Unconfirmed':
			return `The save was sent, but nothing confirmed it, so it may or may not be in the file. ${error.message}`;
		case 'NotFound':
			return 'This todo is no longer in the folder, so it was not saved. Nothing was written.';
		case 'Unencodable':
			return 'The text contains a character that cannot be saved exactly, so it was not saved. Fix the text, then try again.';
		default:
			return `Not saved: ${error.message}`;
	}
}

/** A field whose typed value is kept because the row could not take it. */
type RefusedField = 'title' | 'notes';

/** One refused field's typed value, as the field shows it, and why it was refused. */
type Refusal = { readonly value: string; readonly message: string };

/** What a person is told about a reload that kept their input, including a missing file. */
export function describeReloadError(error: RowReloadError): string {
	return error.name === 'InputChanged'
		? 'You edited this todo while it was being read, so your edits stay. Reload again to replace them.'
		: `This todo could not be read, so your edits stay: ${error.message}`;
}

export function createTodoEditor(
	path: string,
	native: RowEditor<TodoFields>,
	options: { readonly rawMode?: boolean } = {},
) {
	const editor = fromRowEditor(native);
	let rawMode = $state(options.rawMode ?? false);
	/** Rename, delete, recovery, or close is working on this file; input is refused. */
	let fences = $state(0);
	let released = $state(false);
	/** Epicenter asks to quit or restart. Reversible, unlike a release. */
	let departing = $state(false);
	/** Typed title or notes values the row could not take; see the module comment. */
	let refusals = $state.raw<Partial<Record<RefusedField, Refusal>>>({});

	/** Why this editor takes no input or command now, if it does not. */
	function refused(): string | undefined {
		if (released) return RELEASED;
		if (departing) return DEPARTING;
		if (fences > 0) return BUSY;
		return undefined;
	}

	/** Whether the fields view is the one taking input now. */
	function fieldsOpen() {
		return editor.row.status === 'valid' && !rawMode && refused() === undefined;
	}

	/** Submit a complete row from the fields view. Answers why nothing was accepted. */
	function setRow(
		change: (row: CanonicalDocument, file: string) => CanonicalDocument,
	): string | undefined {
		// A leaving fields view can still deliver input; it is not this view's row anymore.
		if (editor.row.status !== 'valid' || !fieldsOpen()) return undefined;
		const { error } = editor.set(
			change(
				{ fields: editor.row.fields, body: editor.row.body },
				editor.row.text,
			),
		);
		return error === null ? undefined : error.refusal.reason;
	}

	/**
	 * Submit one field's typed value. A refusal keeps the value and why for
	 * that field; an accepted value clears that field's refusal.
	 */
	function setField(
		field: RefusedField,
		value: string,
		change: (row: CanonicalDocument, file: string) => CanonicalDocument,
	): string | undefined {
		if (!fieldsOpen()) return undefined;
		const reason = setRow(change);
		const next = { ...refusals };
		delete next[field];
		const message =
			reason === undefined
				? undefined
				: `The ${field} cannot be saved: ${reason}.`;
		if (message !== undefined) next[field] = { value, message };
		refusals = next;
		return message;
	}

	function hasRefusals() {
		return Object.keys(refusals).length > 0;
	}

	/** Whether admitted writes all landed and no field is refused. Never retries. */
	async function flushed(): Promise<boolean> {
		const { error } = await editor.flush();
		return error === null && !hasRefusals();
	}

	/** Stop retaining the native editor, at once and for good. Admitted writes still settle. */
	function release() {
		if (released) return;
		released = true;
	}

	return {
		path,
		/** Tracked `row` and `save` reads and the commands of the native editor. */
		editor,
		get rawMode() {
			return rawMode;
		},
		/**
		 * Input and commands are refused: a rename, delete, recovery, close, or
		 * departure is working on this file, or the owner released this editor.
		 */
		get isFenced() {
			return refused() !== undefined;
		},
		get isSaving() {
			return editor.save.status === 'saving';
		},
		/** Every accepted input is written. */
		get isIdle() {
			return editor.save.status === 'idle' && !hasRefusals();
		},
		/** A write failed or went unconfirmed, or a field is refused; it waits for the person. */
		get hasProblem() {
			return editor.save.status === 'failed' || hasRefusals();
		},
		/** Why each refused field's typed value was not taken, for display beside the fields. */
		get refusals(): readonly string[] {
			return Object.values(refusals).map((refusal) => refusal.message);
		},

		// --- Function bindings. Each guards its own view's gate. -----------

		title(): string {
			if (editor.row.status !== 'valid') return '';
			if (refusals.title !== undefined) return refusals.title.value;
			return typeof editor.row.fields.title === 'string'
				? editor.row.fields.title
				: '';
		},
		setTitle(title: string) {
			return setField('title', title, ({ fields, body }) => ({
				fields: { ...fields, title },
				body,
			}));
		},
		done(): boolean {
			return editor.row.status === 'valid' && editor.row.fields.done === true;
		},
		setDone(done: boolean) {
			const reason = setRow(({ fields, body }) => ({
				fields: { ...fields, done },
				body,
			}));
			return reason === undefined
				? undefined
				: `This value cannot be saved: ${reason}.`;
		},
		notes(): string {
			if (editor.row.status !== 'valid') return '';
			return refusals.notes?.value ?? lf(editor.row.body);
		},
		setNotes(notes: string) {
			return setField('notes', notes, ({ fields }, file) => ({
				fields,
				body: withFileNewlines(notes, file),
			}));
		},
		/** The whole file as the source view shows it. */
		text(): string {
			return lf(editor.row.text);
		},
		setText(next: string) {
			// The raw view exists for an invalid row, or a valid one in raw mode.
			if (
				(editor.row.status === 'valid' && !rawMode) ||
				refused() !== undefined
			)
				return;
			// Raw repair stays in the source after the text becomes valid.
			rawMode = true;
			editor.setText(withFileNewlines(next, editor.row.text));
		},
		/** Why the text on screen does not read as a todo, when it does not. */
		diagnostics():
			| { readonly summary: string; readonly details: readonly string[] }
			| undefined {
			if (editor.row.status === 'valid') return undefined;
			const { error } = editor.row;
			switch (error.name) {
				case 'Nonconforming':
					return {
						summary:
							'Some fields need fixing before they can be edited as fields.',
						details: error.reading.issues.map((issue) => issue.message),
					};
				case 'NoCanonicalForm':
					return {
						summary: `This text cannot be edited as fields: ${error.refusal.reason}.`,
						details: [],
					};
				case 'Unencodable':
					return {
						summary:
							'The text contains a character that cannot be saved exactly.',
						details: [],
					};
			}
		},

		// --- Commands ------------------------------------------------------

		/** Show the source of a valid row. Writes nothing. */
		editSource(): string | undefined {
			const blocked = refused();
			if (blocked !== undefined) return blocked;
			// The source shows the row, which does not hold a refused value.
			if (hasRefusals())
				return 'Fix the value that cannot be saved, or reload, before editing the source.';
			rawMode = true;
			return undefined;
		},
		/** Show the fields of a valid row. Text that is not a valid todo stays in the source. */
		editFields(): string | undefined {
			const blocked = refused();
			if (blocked !== undefined) return blocked;
			if (editor.row.status === 'invalid')
				return 'This text does not read as a todo yet. Fix it in the source first.';
			rawMode = false;
			return undefined;
		},
		/** The person's "Try again" after a failed or unconfirmed write: write the latest input. */
		retry(): string | undefined {
			const blocked = refused();
			if (blocked !== undefined) return blocked;
			editor.retry();
			return undefined;
		},
		/**
		 * The list's checkbox for this open todo: `done` in the complete row on
		 * screen, written now. Answers why nothing was written. Refused while
		 * the todo is edited as source, or writing waits for the person.
		 */
		async toggle(done: boolean): Promise<string | undefined> {
			const blocked = refused();
			if (blocked !== undefined) return blocked;
			if (editor.row.status !== 'valid' || rawMode)
				return 'This todo is open in its source editor. Change it there.';
			if (editor.save.status === 'failed')
				return 'This todo has a save that did not finish. Choose what to do in its editor first.';
			const reason = setRow(({ fields, body }) => ({
				fields: { ...fields, done },
				body,
			}));
			if (reason !== undefined) return `This value cannot be saved: ${reason}.`;
			const { error } = await editor.flush();
			return error === null ? undefined : describeSaveError(error);
		},
		/**
		 * The person's Reload: once admitted writes settle, read the file and
		 * show it, replacing the todo's input, any failed save, and any refused
		 * field. A read that fails, or input that arrives meanwhile, replaces
		 * nothing.
		 */
		async reload() {
			// A refused scalar never reaches the native owner, so fence its
			// control while deliberate reload discards the previous input.
			fences += 1;
			try {
				const result = await editor.reload();
				if (result.error === null) refusals = {};
				return result;
			} finally {
				fences -= 1;
			}
		},
		/** Wait for admitted writes, without fencing input. True when all landed. */
		settle: flushed,
		/**
		 * Run `work` with input fenced: admitted writes finish first, and `work`
		 * learns whether all landed. Input is refused until `work` settles.
		 */
		async fence<T>(work: (settled: boolean) => Promise<T>): Promise<T> {
			fences += 1;
			try {
				return await work(await flushed());
			} finally {
				fences -= 1;
			}
		},
		/**
		 * Refuse input while `work` runs, as when an incoming update is
		 * recovered and may write this row, then read the row again so it shows
		 * what `work` left. A read that fails keeps the row on screen.
		 */
		async hold<T>(work: () => Promise<T>): Promise<T> {
			fences += 1;
			try {
				await editor.flush();
				const done = await work();
				await editor.reload();
				return done;
			} finally {
				fences -= 1;
			}
		},
		/** Epicenter asks to quit or restart: refuse input and commands at once. */
		prepareDeparture() {
			departing = true;
		},
		/** Wait for admitted writes. True when nothing of the person's is unwritten. */
		drainDeparture: flushed,
		/** The round ended without leaving: take input again. */
		resumeDeparture() {
			departing = false;
		},
		/**
		 * Stop retaining the native editor: fence input for good, wait for
		 * admitted writes, and release. Answers whether everything landed; a
		 * failed write is neither retried nor replaced. Only the owner's
		 * terminal close calls this.
		 */
		async close(): Promise<boolean> {
			if (released) return true;
			fences += 1;
			const settled = await flushed();
			release();
			return settled;
		},
		release,
	};
}

export type TodoEditor = ReturnType<typeof createTodoEditor>;
