/**
 * The todo editor: one todo row's retained native row editor (`table.edit`)
 * and the few rules the app keeps around it.
 *
 * The native editor owns the row. Every field, notes, and checkbox change is
 * a complete replacement handed to `set` at once; it is the row the views
 * show from then on and is written last-writer-wins over the existing file,
 * one write at a time with the latest input next. A failed or unconfirmed
 * write keeps the input and error visible. New input saves again; `retry`
 * saves the current input without changing it, and `reload` replaces it with
 * the file. The file is read when the editor opens and again only on
 * `reload`; nothing adopts another writer's change on its own.
 *
 * This is the todo list's editor only. The file's exact text is edited in
 * Files, by a plain editor the owner acquires once this one has settled and
 * been released. A row that does not read as a todo keeps this editor and
 * its input; its view says why and points to Files.
 *
 * This module adds only:
 *
 * - Admission. `set` takes a complete row unless a fence, a departure, or a
 *   release refuses input. The controls compose it from the current `row`,
 *   exactly as it should be written; this module merges nothing.
 * - Why the last row was not taken. A row with no canonical form (a lone
 *   surrogate) changes nothing: the row stays as it was and its controls
 *   show it. Only why is kept, beside the save's own state, until input is
 *   taken, a reload takes the file, or the editor is released. It is not
 *   unsaved input and holds nothing up.
 * - Fences. Rename, delete, a recovery of an incoming update, a handoff to
 *   Files, close, and a departure refuse input while they run; rename,
 *   delete, a handoff, and close first wait for admitted writes and stop
 *   when one failed. The person's reload does not: the native editor keeps
 *   newer input over the file it reads.
 * - Release. The owner (`todos.svelte.ts`) retains one editor per path and
 *   releases it when it forgets the path, a rename moves the row, or Files
 *   takes the file. A released editor refuses input and commands for good.
 *   An editor's path never changes.
 */
import type {
	CanonicalDocument,
	RowEditor,
	RowReloadError,
	RowSaveError,
} from '@epicenter/folder';
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

/** What a person is told about a reload that kept their input, including a missing file. */
export function describeReloadError(error: RowReloadError): string {
	return error.name === 'InputChanged'
		? 'You edited this todo while it was being read, so your edits stay. Reload again to replace them.'
		: `This todo could not be read, so your edits stay: ${error.message}`;
}

/** Why the checkbox changed nothing: the row on screen has no `done` to change. */
const NOT_A_TODO =
	'This todo no longer reads as a todo, so nothing was changed. Open it in Files to repair it.';

export function createTodoEditor(path: string, native: RowEditor<TodoFields>) {
	const editor = fromRowEditor(native);
	/** Rename, delete, recovery, a handoff, or close is working on this file; input is refused. */
	let fences = $state(0);
	let released = $state(false);
	/** Epicenter asks to quit or restart. Reversible, unlike a release. */
	let departing = $state(false);
	/**
	 * Why the last row was not taken; see the module comment. A new object for
	 * each refusal, so the same reason twice is announced twice.
	 */
	let refusal = $state.raw<{ readonly reason: string } | undefined>();

	/** Why this editor takes no input or command now, if it does not. */
	function blocked(): string | undefined {
		if (released) return RELEASED;
		if (departing) return DEPARTING;
		if (fences > 0) return BUSY;
		return undefined;
	}

	/**
	 * Give the row a complete replacement: every field to keep, unknown keys
	 * included, and the body, exactly as it is to be written. A key left out
	 * is removed. A control composes it from a valid `row`, read at the event;
	 * whether the row was valid before does not matter here. A row the codec
	 * refuses changes nothing; only why is kept. Answers why it was not
	 * taken. An unchanged row is saved again.
	 */
	function set(next: CanonicalDocument): string | undefined {
		const why = blocked();
		if (why !== undefined) return why;
		const { error } = editor.set(next);
		refusal = error === null ? undefined : { reason: error.refusal.reason };
		return refusal === undefined
			? undefined
			: `Your last change was not taken: ${refusal.reason}.`;
	}

	/** Whether admitted writes all landed. Never retries. */
	async function flushed(): Promise<boolean> {
		const { error } = await editor.waitForSaves();
		return error === null;
	}

	/** Stop retaining the native editor, at once and for good. Admitted writes still settle. */
	function release() {
		if (released) return;
		released = true;
		refusal = undefined;
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
		/**
		 * Why the last row was not taken, in the codec's words, or `undefined`.
		 * Nothing typed is kept: the row and its controls show the input taken
		 * before it.
		 */
		get refusal() {
			return refusal;
		},
		/**
		 * Input and commands are refused: a rename, delete, recovery, handoff,
		 * close, or departure is working on this file, or the owner released
		 * this editor.
		 */
		get isFenced() {
			return blocked() !== undefined;
		},
		get isSaving() {
			return editor.save.status === 'saving';
		},
		/** Every accepted input is written. */
		get isIdle() {
			return editor.save.status === 'idle';
		},
		/** A write failed or went unconfirmed; it waits for the person. */
		get hasProblem() {
			return editor.save.status === 'failed';
		},

		set,
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

		/** The person's "Try again" after a failed or unconfirmed write: write the latest input. */
		retry(): string | undefined {
			const why = blocked();
			if (why !== undefined) return why;
			editor.retry();
			return undefined;
		},
		/**
		 * The list's checkbox for this open todo: `done` in the complete row on
		 * screen, written now. Answers why nothing was written.
		 */
		async toggle(done: boolean): Promise<string | undefined> {
			const why = blocked();
			if (why !== undefined) return why;
			const { row } = editor;
			if (row.status !== 'valid') return NOT_A_TODO;
			const problem = set({ ...row, fields: { ...row.fields, done } });
			if (problem !== undefined) return problem;
			const { error } = await editor.waitForSaves();
			return error === null ? undefined : describeSaveError(error);
		},
		/**
		 * The person's Reload: once admitted writes settle, read the file and
		 * show it, replacing the todo's input, any failed save, and why the last
		 * row was not taken. A read that fails replaces nothing. Typing goes on
		 * meanwhile: input accepted after the call stands, and the native
		 * editor answers `InputChanged` instead of adopting the file.
		 */
		async reload() {
			const result = await editor.reload();
			if (result.error === null) refusal = undefined;
			return result;
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
