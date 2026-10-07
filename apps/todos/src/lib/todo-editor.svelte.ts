/**
 * The todo editor: one todo row's retained native row editor (`table.edit`)
 * and the few rules the app keeps around it.
 *
 * The native editor owns the row. Every field, notes, source, and checkbox
 * change is a complete replacement handed to `set` or `setText` at once; it
 * is the row the views show from then on and is written last-writer-wins
 * over the existing file, one write at a time with the latest input next.
 * A failed or unconfirmed write keeps the input and error visible. New input
 * saves again; `retry` saves the current input without changing it, and
 * `reload` replaces it with the file. The file is read when the editor opens and again
 * only on `reload`; nothing adopts another writer's change on its own.
 *
 * This module adds only:
 *
 * - The source preference. Fields and source are two views of the same row;
 *   a raw edit keeps the source view after the text becomes valid, until the
 *   person chooses Edit fields. It is view state, kept here so it outlives
 *   the views and follows a rename.
 * - Admission. `set` takes a complete row only while the row reads as valid
 *   and shows its fields, and no fence or release refuses input. The views
 *   compose it from the current `row`; this module merges nothing.
 * - Refused fields. A title or notes value the row cannot be written with
 *   (it has no canonical form) is accepted by nothing, so this editor keeps
 *   the value its control supplied and why, and the field shows it for
 *   correction. It is not a second row: the rest of the row stays the
 *   native editor's. A row that keeps that field as the native editor holds
 *   it still saves; one that changes it is refused unless it comes from that
 *   field's own control, whose next accepted value clears it. Only a
 *   deliberate reload drops it. Until then it counts as unsaved input, so
 *   leaving, rename, delete, close, and a departure treat it as not settled.
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

/** Why fields input was refused while the row shows its source. */
const IN_SOURCE = 'This todo is open in its source editor. Change it there.';

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
	function blocked(): string | undefined {
		if (released) return RELEASED;
		if (departing) return DEPARTING;
		if (fences > 0) return BUSY;
		return undefined;
	}

	function hasRefusals() {
		return Object.keys(refusals).length > 0;
	}

	/**
	 * Give the row a complete replacement: every field to keep, unknown keys
	 * included, and the body. A key left out is removed. Taken only while the
	 * row reads as valid and shows its fields. Answers why it was not taken.
	 *
	 * A refused field blocks a row that changes it from what the native
	 * editor holds, unless the row comes from that field's own control. The
	 * `title` or `notes` control keeps its value when the row cannot take it,
	 * and an accepted one clears it. The notes control reports LF, so its
	 * body is written in the file's newline convention. An unchanged row is
	 * saved again.
	 */
	function set(
		next: CanonicalDocument,
		{ control }: { readonly control?: RefusedField } = {},
	): string | undefined {
		const why = blocked();
		if (why !== undefined) return why;
		const { row } = editor;
		if (row.status !== 'valid' || rawMode) return IN_SOURCE;
		const document =
			control === 'notes'
				? { ...next, body: withFileNewlines(next.body, row.text) }
				: next;
		const changed: Record<RefusedField, boolean> = {
			title: document.fields.title !== row.fields.title,
			notes: document.body !== row.body,
		};
		const held = (['title', 'notes'] as const).find(
			(field) =>
				field !== control && refusals[field] !== undefined && changed[field],
		);
		if (held !== undefined)
			return `What you typed in the ${held} is not saved. Fix it there first.`;
		const { error } = editor.set(document);
		if (control === undefined)
			return error === null
				? undefined
				: `This value cannot be saved: ${error.refusal.reason}.`;
		const others = { ...refusals };
		delete others[control];
		const value = control === 'title' ? next.fields.title : next.body;
		const message =
			error === null
				? undefined
				: `The ${control} cannot be saved: ${error.refusal.reason}.`;
		refusals =
			message === undefined || typeof value !== 'string'
				? others
				: { ...others, [control]: { value, message } };
		return message;
	}

	/** Whether admitted writes all landed and no field is refused. Never retries. */
	async function flushed(): Promise<boolean> {
		const { error } = await editor.waitForSaves();
		return error === null && !hasRefusals();
	}

	/** Stop retaining the native editor, at once and for good. Admitted writes still settle. */
	function release() {
		if (released) return;
		released = true;
	}

	return {
		path,
		/** The latest input, valid or invalid, read tracked. `set` takes a row composed from it. */
		get row() {
			return editor.row;
		},
		/** The native editor's publication, read tracked: idle, saving, or failed. */
		get save() {
			return editor.save;
		},
		/** Values the row could not take, by the control that supplied them, and why. */
		get refused(): Readonly<Partial<Record<RefusedField, Refusal>>> {
			return refusals;
		},
		get rawMode() {
			return rawMode;
		},
		/**
		 * Input and commands are refused: a rename, delete, recovery, close, or
		 * departure is working on this file, or the owner released this editor.
		 */
		get isFenced() {
			return blocked() !== undefined;
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

		// --- Input. A leaving view can still deliver it, so each kind is ---
		// taken only while the row shows the view it belongs to.

		set,
		/** The source view's text, in LF; the file's newline convention is restored. */
		setText(next: string) {
			// The raw view exists for an invalid row, or a valid one in raw mode.
			if (
				(editor.row.status === 'valid' && !rawMode) ||
				blocked() !== undefined
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
			const why = blocked();
			if (why !== undefined) return why;
			// The source shows the row, which does not hold a refused value.
			if (hasRefusals())
				return 'Fix the value that cannot be saved, or reload, before editing the source.';
			rawMode = true;
			return undefined;
		},
		/** Show the fields of a valid row. Text that is not a valid todo stays in the source. */
		editFields(): string | undefined {
			const why = blocked();
			if (why !== undefined) return why;
			if (editor.row.status === 'invalid')
				return 'This text does not read as a todo yet. Fix it in the source first.';
			rawMode = false;
			return undefined;
		},
		/** The person's "Try again" after a failed or unconfirmed write: write the latest input. */
		retry(): string | undefined {
			const why = blocked();
			if (why !== undefined) return why;
			editor.retry();
			return undefined;
		},
		/**
		 * The list's checkbox for this open todo: `done` in the complete row on
		 * screen, written now. Answers why nothing was written. Refused while
		 * the todo is edited as source.
		 */
		async toggle(done: boolean): Promise<string | undefined> {
			const why = blocked();
			if (why !== undefined) return why;
			const { row } = editor;
			if (row.status !== 'valid') return IN_SOURCE;
			const problem = set({ ...row, fields: { ...row.fields, done } });
			if (problem !== undefined) return problem;
			const { error } = await editor.waitForSaves();
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
