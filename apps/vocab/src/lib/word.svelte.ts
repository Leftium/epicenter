/**
 * One saved word: its row editor and every operation on its file.
 *
 * The folder's row editor owns the word's input and publishes it. Every note
 * keystroke, stage press, and repair keystroke goes to it at once as the
 * whole word: `set` for note and stage, with the metadata and body the row
 * already holds, and `setText` for exact file text. The editor keeps one write
 * running and the latest input waiting, and later input replaces the file
 * whatever another tab saved there meanwhile. What the learner sees is the
 * editor's row. The one exception is a note the editor refused because no
 * row can hold it, such as one with half of a surrogate pair: that note text
 * alone stays in the field with the reason until the learner corrects or
 * discards it, and the word is not deleted or left without asking meanwhile.
 *
 * - A failed save, or one whose answer was lost, keeps the learner's input
 *   shown with the error. Waiting and later input saves again; "Try again"
 *   resubmits the current text, and reloading replaces it with the file.
 * - The editor reads the file once, when the word's card opens it. Changes
 *   made elsewhere reach it only through an explicit reload.
 * - A file that is not a valid word shows its exact text for repair through
 *   the same editor. No save ever creates a file that is gone.
 * - Deletion and closing stop every view of the word from taking input
 *   first, and let admitted saves settle. A delete whose answer was lost
 *   keeps the word until the learner reads the file again or lets it go.
 */
import {
	FileError,
	type RowError,
	type RowSaveError,
	type TableEditError,
} from '@epicenter/folder';
import { withFileNewlines } from '@epicenter/folder/file-browser';
import { fromRowEditor } from '@epicenter/folder/svelte';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Entry, Stage, VocabTables } from './data.js';

type EntriesTable = VocabTables['entries'];
type WordEditor = NonNullable<
	Awaited<ReturnType<EntriesTable['edit']>>['data']
>;
type WordState = ReturnType<WordEditor['get']>;
type WordRow = WordState['row'];
type SaveState = WordState['save'];
type ReloadError = NonNullable<
	Awaited<ReturnType<WordEditor['reload']>>['error']
>;

/** Textareas report LF; the file's own convention is restored on saving. */
export const lf = (text: string) => text.replace(/\r\n?/g, '\n');

/** Why readable text is not a valid word, in a sentence. */
export function describeRowError(error: RowError): string {
	switch (error.name) {
		case 'Nonconforming':
			return error.reading.issues.map((issue) => issue.message).join('; ');
		case 'NoCanonicalForm':
			return error.refusal.reason;
		case 'Unencodable':
			return 'The text has a lone surrogate, which a file cannot hold exactly.';
		default:
			return error satisfies never;
	}
}

/** Why a save did not land, or that its answer was lost, as the learner reads it. */
export function describeSaveError(error: RowSaveError): string {
	switch (error.name) {
		case 'Unconfirmed':
			return `Whether your last change was saved is not known. ${error.message}`;
		case 'NotFound':
			return 'Your last change was not saved: the word’s file is gone, and saving never creates it again.';
		default:
			return `Your last change was not saved: ${error.message}`;
	}
}

/** Why reading the file again replaced nothing. */
function describeReloadError(error: ReloadError): string {
	switch (error.name) {
		case 'InputChanged':
			return 'You changed this word while its file was being read, so your text was kept. Reload again to replace it.';
		case 'NotFound':
			return 'This word’s file is gone.';
		default:
			return `This word’s file could not be read: ${error.message}`;
	}
}

/** Why a reload waits while a refused note is kept in the field. */
const REFUSED_NOTE_HELD =
	'Your note could not be saved as typed. Correct it or discard it first.';

function describeOpenError(error: TableEditError): string {
	return error.name === 'NotFound'
		? 'This word’s file is gone, so it cannot be edited.'
		: `This word could not be opened: ${error.message}`;
}

export type Word = ReturnType<typeof createWord>;

export function createWord({
	table,
	id,
	listed,
	onSettled,
}: {
	table: EntriesTable;
	id: string;
	/** The word as the list last read it, if it is listed. */
	listed: () => Entry | undefined;
	/** This word's saves landed: read it into the list. */
	onSettled: () => Promise<void>;
}) {
	/** The row editor, once one is open. Kept until the word closes. */
	let editor = $state.raw<WordEditor | undefined>();
	let opening = $state.raw<Promise<void> | undefined>();
	/** Why the latest attempt to open gave no editor. */
	let openError = $state.raw<TableEditError | undefined>();
	/** The latest reload found no file, until one finds it again. */
	let goneOnRead = $state(false);
	/** A delete was sent and no answer came back; held until the file is read or let go. */
	let deletion = $state<string | undefined>();
	/** Note text the editor refused, and why, until a later note is accepted or this is discarded. */
	let refusedNote = $state.raw<
		{ readonly text: string; readonly reason: string } | undefined
	>();
	/** An operation is under way: no view takes input or starts new work. */
	let fence = $state<'deleting' | 'closing' | 'reloading' | undefined>();
	/** The delete under way, which closing waits for. */
	let operation: Promise<unknown> | undefined;
	/** Why the word is closed for good: nothing typed is taken and no editor is installed. */
	let ended: string | undefined;
	/** Waiting for this word's writes to land, to list them. */
	let following = false;

	const stopped = (): string | null => {
		if (ended !== undefined) return ended;
		if (fence === 'deleting') return 'This word is being deleted.';
		if (fence === 'reloading') return 'This word is being read again.';
		return null;
	};

	const reactive = () =>
		editor === undefined ? undefined : fromRowEditor(editor);

	/** Whether the word's file is known to be gone. */
	function missing(save: SaveState | undefined): boolean {
		if (editor === undefined) return openError?.name === 'NotFound';
		return (
			goneOnRead ||
			(save?.status === 'failed' && save.error.name === 'NotFound')
		);
	}

	/**
	 * Once the writes admitted now and while waiting have landed, list the
	 * word as saved. A failure stays on the editor until another save starts
	 * or a reload succeeds; each accepted edit follows again.
	 */
	function follow(current: WordEditor) {
		if (following) return;
		following = true;
		void (async () => {
			let landed = false;
			for (;;) {
				const { error: saveError } = await current.waitForSaves();
				if (saveError !== null || editor !== current) break;
				if (current.get().save.status !== 'saving') {
					landed = true;
					break;
				}
			}
			following = false;
			if (!landed || ended !== undefined) return;
			// A write replaced the file, so a delete without an answer did not remove it.
			deletion = undefined;
			goneOnRead = false;
			await onSettled();
			// Input admitted while the list was read is followed too.
			if (current.get().save.status === 'saving') follow(current);
		})();
	}

	async function acquire(): Promise<void> {
		let result: Awaited<ReturnType<EntriesTable['edit']>>;
		try {
			result = await table.edit(id);
		} catch (cause) {
			result = FileError.Io({
				path: `entries/${id}.md`,
				operation: 'read',
				cause,
			});
		}
		// Closed meanwhile: the editor is not kept.
		if (ended !== undefined || editor !== undefined) return;
		const { data: opened, error: openFailure } = result;
		openError = openFailure ?? undefined;
		if (openFailure === null) editor = opened;
	}

	/** Open the editor once; a call while it opens joins that attempt. */
	function open(): Promise<void> {
		if (ended !== undefined || fence !== undefined || editor !== undefined)
			return opening ?? Promise.resolve();
		opening ??= acquire().finally(() => {
			opening = undefined;
		});
		return opening;
	}

	/** Why there is no editor to save with. */
	const unavailable = () =>
		openError === undefined
			? 'This word could not be opened.'
			: describeOpenError(openError);

	return {
		id,
		/** The editor's row, tracked; `undefined` until the editor opens. */
		get row(): WordRow | undefined {
			return reactive()?.row;
		},
		/** The editor's save state, tracked; `undefined` until the editor opens. */
		get save(): SaveState | undefined {
			return reactive()?.save;
		},
		get opening() {
			return opening !== undefined;
		},
		/** Why the latest attempt to open the word gave no editor. */
		get openError() {
			return openError === undefined ? undefined : describeOpenError(openError);
		},
		/** The word's file is known to be gone. Nothing saved here creates it again. */
		get missing() {
			return missing(reactive()?.save);
		},
		/** An operation is under way, or the word is closed. */
		get fenced() {
			return fence !== undefined || ended !== undefined;
		},
		/** A delete whose answer was lost, until the file is read or the word is let go. */
		get deletion() {
			return deletion;
		},
		/** Note text the editor refused, and why, while it is kept in the field. */
		get refusedNote() {
			return refusedNote;
		},
		/** Whether a save is running or failed, a note was refused, or a delete is in flight or unanswered. */
		get unsettled() {
			const save = editor?.get().save.status;
			return (
				refusedNote !== undefined ||
				deletion !== undefined ||
				operation !== undefined ||
				save === 'saving' ||
				save === 'failed'
			);
		},
		/** Whether a stage press can save now: the word is a valid row, or not opened yet, and its file is not known to be gone. */
		get stageable(): boolean {
			if (ended !== undefined || fence !== undefined) return false;
			const editing = reactive();
			if (missing(editing?.save)) return false;
			return editing === undefined || editing.row.status === 'valid';
		},
		open,

		// --- The note and the stage --------------------------------------

		/** The note the field shows: a refused note, else the editor's, else the listed one. */
		note(): string {
			if (refusedNote !== undefined) return refusedNote.text;
			const editing = reactive();
			if (editing?.row.status === 'valid') return lf(editing.row.fields.note);
			return editor === undefined ? lf(listed()?.note ?? '') : '';
		},
		/** The stage the controls show: the editor's, else the listed one. */
		stage(): Stage | undefined {
			const editing = reactive();
			if (editing?.row.status === 'valid') return editing.row.fields.stage;
			return editor === undefined ? listed()?.stage : undefined;
		},
		/**
		 * Type the note: the whole word goes to the editor at once, with every
		 * other field and the body as the row holds them. Taken only while the
		 * row is valid. A note no row can hold is kept here as typed, with why,
		 * and nothing is sent. Answers why nothing was taken, or null.
		 */
		inputNote(text: string): string | null {
			if (stopped() !== null || editor === undefined) return stopped();
			const { row } = editor.get();
			if (row.status !== 'valid') return null;
			const { error: setError } = editor.set({
				fields: {
					...row.fields,
					note: withFileNewlines(text, row.fields.note),
				},
				body: row.body,
			});
			if (setError !== null) {
				refusedNote = { text, reason: setError.refusal.reason };
				return null;
			}
			refusedNote = undefined;
			follow(editor);
			return null;
		},
		/** Drop a refused note; the field shows the word's own note again. */
		discardRefusedNote() {
			refusedNote = undefined;
		},
		/**
		 * Press a stage: the whole word goes to the editor with it, and this
		 * answers once its saves land. Answers why it was not saved, or null.
		 */
		async setStage(stage: Stage): Promise<string | null> {
			if (stopped() !== null) return stopped();
			if (editor === undefined) await open();
			if (stopped() !== null) return stopped();
			const current = editor;
			if (current === undefined) return unavailable();
			const { row } = current.get();
			if (row.status !== 'valid')
				return `This word’s file needs repair before its stage can change: ${describeRowError(row.error)}`;
			const { error: setError } = current.set({
				fields: { ...row.fields, stage },
				body: row.body,
			});
			if (setError !== null)
				return `This word cannot be saved: ${setError.refusal.reason}`;
			follow(current);
			const { error: saveError } = await current.waitForSaves();
			return saveError === null ? null : describeSaveError(saveError);
		},

		// --- Repair as exact text ------------------------------------------

		/** The text the repair field shows: the editor's exact text. */
		repairText(): string {
			const editing = reactive();
			return editing === undefined ? '' : lf(editing.row.text);
		},
		/** Type the file's exact text, saved in its own line endings. */
		inputRepair(text: string) {
			if (stopped() !== null || editor === undefined) return;
			const { row } = editor.get();
			editor.setText(withFileNewlines(text, row.text));
			follow(editor);
		},

		// --- After a failed save ---------------------------------------------

		/** Send the latest input again after a failed or unknown save. */
		retry() {
			if (stopped() !== null || editor === undefined) return;
			editor.retry();
			follow(editor);
		},
		/**
		 * Read the file and replace the input with it, the learner's way to
		 * discard a failed change or see what another tab saved. The input stays
		 * when the read fails or the learner types meanwhile. Answers why
		 * nothing was replaced, or null.
		 */
		async reload(): Promise<string | null> {
			if (stopped() !== null) return stopped();
			if (refusedNote !== undefined) return REFUSED_NOTE_HELD;
			const current = editor;
			if (current === undefined) {
				await open();
				return editor === undefined ? unavailable() : null;
			}
			fence = 'reloading';
			try {
				const { error: reloadError } = await current.reload();
				if (editor !== current || ended !== undefined) return stopped();
				if (reloadError !== null) {
					if (reloadError.name === 'NotFound') goneOnRead = true;
					return describeReloadError(reloadError);
				}
				deletion = undefined;
				goneOnRead = false;
				await onSettled();
				return null;
			} finally {
				if (fence === 'reloading') fence = undefined;
			}
		},

		// --- Deletion and closing --------------------------------------------

		/**
		 * Delete the word. The exact text this word's editor shows is fixed
		 * when this is called, before anything waits. Input stops at once; the
		 * saves already admitted settle; then `remove` decides, from that text
		 * and what the caller fixed with it, whether the file as it is then
		 * may go. Refused, the word goes on; done, it is closed. With no
		 * answer, thrown or `Unconfirmed`, it is kept until the file is read or
		 * the learner lets it go. `'busy'` while another delete holds the word;
		 * `'held'` while a refused note waits to be corrected or discarded.
		 */
		remove<
			T extends {
				readonly error: {
					readonly name: string;
					readonly message: string;
				} | null;
			},
		>(
			remove: (shown: string | undefined) => Promise<T>,
		): Promise<T | 'busy' | 'held'> {
			if (stopped() !== null) return Promise.resolve('busy');
			if (refusedNote !== undefined) return Promise.resolve('held');
			const shown = editor?.get().row.text;
			fence = 'deleting';
			const running = (async () => {
				let removed: T;
				try {
					if (opening !== undefined) await opening;
					// A failed save is left as it is; the delete is decided below.
					await editor?.waitForSaves();
					removed = await remove(shown);
				} catch (cause) {
					if (ended === undefined) deletion = extractErrorMessage(cause);
					throw cause;
				}
				if (removed.error === null) {
					ended = 'This word was deleted.';
					editor = undefined;
				} else if (removed.error.name === 'Unconfirmed' && ended === undefined)
					deletion = removed.error.message;
				return removed;
			})();
			operation = running;
			const done = () => {
				if (fence === 'deleting') fence = undefined;
				if (operation === running) operation = undefined;
			};
			running.then(done, done);
			return running;
		},
		/**
		 * Stop the word for good: nothing typed is taken from now on, the
		 * delete under way and the saves already admitted settle, and the
		 * editor is let go.
		 */
		async close(): Promise<void> {
			fence = 'closing';
			ended ??= 'This page is closing, so nothing more is saved here.';
			if (opening !== undefined) await opening;
			await operation?.catch(() => {});
			await editor?.waitForSaves();
			editor = undefined;
		},
	};
}
