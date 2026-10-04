/**
 * Raw text editors (ADR-0465): the plain editor for any text file, and the
 * source editor that repairs a todo row the structured editor cannot open.
 *
 * A draft's `buffer` is the text on screen, including unsaved typing.
 * `baseline` is the saved file the next conditional save is checked against. A
 * save captures one generation of the buffer; success advances the baseline to
 * the accepted file and leaves newer typing dirty. The accepted file holds the
 * text of the bytes that were sent, which differs from the typed string where
 * encoding replaced an unpaired surrogate; a buffer still at the generation
 * that was sent becomes that text, so the draft settles. A conflict pauses autosave
 * and keeps the input until the person chooses. A conflict whose saved file
 * cannot be read is a failed save, never a removal. A save whose reply was
 * lost, or whose store threw, is unknown, and a later read of the same bytes
 * does not make it saved.
 * A failed or unknown save also stops automatic saves: new typing stays on
 * screen, and no timer, settle, rename, or close sends it until the person
 * tries again. That attempt is still checked against the baseline, which
 * stays where it was. A rename runs through the draft's `move`, which holds saves
 * until the file is at its new path; a move that fails, even one that left a
 * copy at the new path, keeps the draft at the old one. Git outcomes never
 * affect this state.
 *
 * Ordinary files save through raw conditional replacements; a row repair
 * saves its complete text through `table.replace`. Structured todo editing is
 * a different save shape: see `todo-editor.svelte.ts`.
 */
import type { FileTable, FolderFiles, TextCapture } from '@epicenter/folder';
import { FileError, rowStemOf } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import { readTextFile, type SubmittedText, submittedText } from './files.js';

/**
 * One saved text file as its draft last accepted it: the capture the next
 * conditional save is checked against, with the text those bytes decode to.
 */
export type SavedText = TextCapture;

export type SaveState =
	| { readonly kind: 'saved' }
	| { readonly kind: 'saving' }
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * A request's reply was lost, or its storage threw: a save's bytes may or
	 * may not be in the file, or a delete may or may not have removed it. No
	 * later read answers it; only the person's choice does. `message` is what
	 * a save's storage threw, when that is why its outcome is unknown.
	 */
	| {
			readonly kind: 'unknown';
			readonly operation: 'save' | 'delete';
			readonly message?: string;
	  }
	| {
			readonly kind: 'conflict';
			readonly message: string;
			/** The saved file now, or undefined when it was removed. */
			readonly current: SavedText | undefined;
	  };

/** Where a draft saves: one conditional write, and a fresh read for conflict review. */
type DraftStore = {
	/** The accepted file's `text` is the text of the submitted bytes. */
	write(
		baseline: SavedText,
		submitted: SubmittedText,
	): Promise<
		Result<SavedText, { readonly name: string; readonly message: string }>
	>;
	/**
	 * The saved file now. Only absence is `undefined`; a file that could not be
	 * read, or is no longer editable text, is an error and never reads as removed.
	 */
	read(
		baseline: SavedText,
	): Promise<Result<SavedText | undefined, { readonly message: string }>>;
};

/** Typing batches for this long before a save; the folder adds no Git delay. */
export const TYPING_BATCH_MS = 400;

const messageOf = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export type TextFileEditor = ReturnType<typeof createDraft>;

function createDraft(
	store: DraftStore,
	initial: SavedText,
	onSaved: () => void,
) {
	let baseline = $state.raw<SavedText>(initial);
	let buffer = $state(initial.text);
	let saveState = $state.raw<SaveState>({ kind: 'saved' });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	/** Pending while a rename owns the file's path; resolves when it settles. */
	let moving: Promise<void> | undefined;

	const dirty = () => buffer !== baseline.text;

	/**
	 * Nothing is sent on its own while the person must choose: a conflict to
	 * review, or a save that failed or whose reply was lost. A hash check makes
	 * a resend safe from overwriting, but it is still a new request the person
	 * did not make; only `retry` or a conflict choice sends again.
	 */
	const isHeld = () =>
		saveState.kind === 'conflict' ||
		saveState.kind === 'failed' ||
		saveState.kind === 'unknown';

	function schedule() {
		clearTimeout(timer);
		if (isHeld() || moving) return;
		timer = setTimeout(() => void save(), TYPING_BATCH_MS);
	}

	function input(text: string) {
		buffer = text;
		schedule();
	}

	async function saveOnce() {
		const captured = buffer;
		const observed = baseline;
		saveState = { kind: 'saving' };
		let result: Awaited<ReturnType<DraftStore['write']>>;
		try {
			result = await store.write(observed, submittedText(captured));
		} catch (cause) {
			// A store that throws (its host went away mid-call) must not leave the
			// draft saving forever, and cannot say whether the bytes landed: the
			// save is unknown, as a lost reply is. The baseline and the input
			// stay for the person's retry.
			saveState = {
				kind: 'unknown',
				operation: 'save',
				message: messageOf(cause),
			};
			return;
		}
		if (result.error === null) {
			baseline = result.data;
			// The same text unless encoding replaced an unpaired surrogate.
			// Newer typing is a later generation and stays as typed.
			if (buffer === captured) buffer = result.data.text;
			saveState = { kind: 'saved' };
			onSaved();
			return;
		}
		if (result.error.name === 'Unconfirmed') {
			// The baseline stays, so a retry is checked against the file as
			// it was: bytes that did land read as a change to review.
			saveState = { kind: 'unknown', operation: 'save' };
			return;
		}
		if (result.error.name !== 'Conflict') {
			saveState = { kind: 'failed', message: result.error.message };
			return;
		}
		// The conflict wrote nothing; a read that throws only hides the file.
		const current = await store
			.read(observed)
			.catch((cause: unknown) => Err({ message: messageOf(cause) }));
		// Without the saved file there is nothing to review or replace. The
		// baseline stays, so a retry repeats this save and this read.
		saveState = current.error
			? {
					kind: 'failed',
					message: `This file changed elsewhere, and the saved version cannot be shown: ${current.error.message}`,
				}
			: {
					kind: 'conflict',
					message: result.error.message,
					current: current.data,
				};
	}

	/** Run admitted saves to completion. A move drains through here before it runs. */
	async function drain(): Promise<void> {
		clearTimeout(timer);
		if (isHeld()) return;
		if (saving) {
			await saving;
			return dirty() ? drain() : undefined;
		}
		if (!dirty()) return;
		saving = saveOnce();
		try {
			await saving;
		} finally {
			saving = undefined;
		}
		// Typing that arrived during the save is still dirty; batch it again.
		if (dirty() && saveState.kind === 'saved') schedule();
	}

	/**
	 * Save the current generation now, as the typing timer does. Resolves when
	 * no save is running. A held draft sends nothing; see `isHeld`. A move
	 * holds saves too: this returns at once, the input stays dirty, and it
	 * saves when the move settles.
	 */
	async function save(): Promise<void> {
		if (!moving) await drain();
	}

	return {
		get baseline() {
			return baseline;
		},
		get buffer() {
			return buffer;
		},
		get saveState() {
			return saveState;
		},
		get dirty() {
			return dirty();
		},
		/** Nothing typed is waiting, saving, failed, or in conflict. */
		get isIdle() {
			return !dirty() && saveState.kind === 'saved';
		},
		get isSaving() {
			return saveState.kind === 'saving';
		},
		/** The input cannot save on its own until the person chooses. */
		get hasProblem() {
			return (
				saveState.kind === 'failed' ||
				saveState.kind === 'unknown' ||
				saveState.kind === 'conflict'
			);
		},
		/** Discarding is offered only when the input cannot save. */
		get isDiscardable() {
			return (
				saveState.kind === 'failed' ||
				saveState.kind === 'unknown' ||
				(saveState.kind === 'conflict' && saveState.current === undefined)
			);
		},
		get path() {
			return baseline.path;
		},
		/** Replace the whole buffer, as a source editor does. */
		input,
		save,
		/**
		 * Same-byte observations adopt the newer observation without replacing input.
		 * Changed bytes are adopted only by a clean, idle draft; a dirty draft
		 * keeps its sha256 so its next save detects the other writer.
		 */
		observe(next: SavedText) {
			if (next.path !== baseline.path) return;
			if (next.sha256 === baseline.sha256) {
				baseline = next;
				return;
			}
			if (dirty() || saving || moving || saveState.kind !== 'saved') return;
			baseline = next;
			buffer = next.text;
		},
		/** Conflict choice: discard my input and load the saved file. */
		loadSaved() {
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			buffer = saveState.current.text;
			saveState = { kind: 'saved' };
			// The reviewed version may predate later external writes. Refresh
			// now that this editor can adopt them, without publishing anything.
			onSaved();
		},
		/** Conflict choice: keep my input and save it over the version I reviewed. */
		async keepMine() {
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			saveState = { kind: 'saved' };
			await save();
		},
		/**
		 * The person's explicit attempt after a failed save, or a save or
		 * delete whose reply was lost: one new save of the current text, still
		 * checked against the baseline, so bytes an unknown save did land, or a
		 * removal an unknown delete did make, come back as a conflict to review.
		 */
		async retry() {
			if (saveState.kind === 'failed' || saveState.kind === 'unknown')
				saveState = { kind: 'saved' };
			await save();
		},
		/**
		 * Settle pending input before the file is deleted or closed. Waits for a
		 * running move, then for the saves it held. A held draft sends nothing
		 * and answers false.
		 */
		async settle(): Promise<boolean> {
			while (moving) await moving;
			await drain();
			return !dirty() && saveState.kind === 'saved';
		},
		/**
		 * Rename this draft's file. `run` performs the conditional move against
		 * the settled baseline and answers the accepted file at its new path.
		 *
		 * Admitted saves finish first and no save starts until `run` resolves, so
		 * no write is ever checked against the path being retired. Typing is
		 * accepted throughout. Success adopts the moved file before saves resume,
		 * and input typed meanwhile saves there. A failure adopts nothing: the
		 * baseline stays the last accepted file and `run`'s error is returned.
		 *
		 * Returns `undefined` without running when the input could not be saved
		 * first or another move is running.
		 */
		async move(
			run: (settled: SavedText) => Promise<Result<SavedText, string>>,
		): Promise<Result<SavedText, string> | undefined> {
			if (moving) return undefined;
			let finish = () => {};
			moving = new Promise<void>((resolve) => {
				finish = resolve;
			});
			try {
				await drain();
				if (dirty() || saveState.kind !== 'saved') return undefined;
				const result = await run(baseline);
				if (result.error === null) {
					const wasDirty = dirty();
					baseline = result.data;
					if (!wasDirty) buffer = result.data.text;
				}
				return result;
			} finally {
				moving = undefined;
				finish();
				if (dirty() && saveState.kind === 'saved') schedule();
			}
		},
		/**
		 * Hold saves while `work` runs, as when an incoming update is recovered
		 * and may write this file. A save already running finishes first, and
		 * none starts until `work` settles. Typing is accepted throughout and
		 * saves afterward under the usual rules: still checked against the
		 * baseline, so a file `work` changed comes back as a conflict.
		 */
		async hold<T>(work: () => Promise<T>): Promise<T> {
			while (moving) await moving;
			const finished = Promise.withResolvers<void>();
			moving = finished.promise;
			try {
				clearTimeout(timer);
				while (saving) await saving;
				return await work();
			} finally {
				moving = undefined;
				finished.resolve();
				if (dirty() && saveState.kind === 'saved') schedule();
			}
		},
		/**
		 * Delete this draft's file. `run` removes the version the person
		 * confirmed. A save already running finishes first, and none starts
		 * until `run` answers, so no save of this draft lands during the delete.
		 * Typing is accepted throughout.
		 *
		 * A delete whose reply was lost, or that threw, may or may not have
		 * removed the file: the draft becomes unknown before this returns, so
		 * nothing is sent on its own, and no later read answers it; only the
		 * person's choice does. A delete that removed the file leaves typing
		 * that arrived meanwhile as a draft of a removed file.
		 *
		 * Returns `undefined` without running while the draft holds input that
		 * is not saved or another move or delete is running.
		 */
		async remove(
			run: () => Promise<Result<undefined, FileError>>,
		): Promise<Result<undefined, FileError> | undefined> {
			if (moving) return undefined;
			const finished = Promise.withResolvers<void>();
			moving = finished.promise;
			try {
				clearTimeout(timer);
				while (saving) await saving;
				if (dirty() || saveState.kind !== 'saved') return undefined;
				let removed: Result<undefined, FileError>;
				try {
					removed = await run();
				} catch (cause) {
					removed = FileError.Unconfirmed({
						path: baseline.path,
						operation: 'remove',
						cause,
					});
				}
				if (removed.error?.name === 'Unconfirmed')
					saveState = { kind: 'unknown', operation: 'delete' };
				return removed;
			} finally {
				moving = undefined;
				finished.resolve();
				if (dirty() && saveState.kind === 'saved') schedule();
			}
		},
		dispose() {
			clearTimeout(timer);
		},
	};
}

/**
 * A text file editor whose conditional saves follow the folder's history
 * policy. A save replaces the baseline's captured bytes with the submitted
 * ones; the capture it returns, with the text of those bytes, is the next
 * baseline.
 */
export function createTextFileEditor(
	files: FolderFiles,
	file: SavedText,
	onSaved: () => void,
): TextFileEditor {
	return createDraft(
		{
			async write(baseline, { bytes, text }) {
				const replaced = await files.replace(baseline, bytes);
				if (replaced.error) return Err(replaced.error);
				return Ok({ ...replaced.data, text });
			},
			async read(baseline) {
				const read = await readTextFile(files, baseline.path);
				if (read.error)
					return read.error.name === 'NotFound' ? Ok(undefined) : read;
				if (read.data.kind === 'text') return Ok(read.data.file);
				return Err({
					message:
						read.data.kind === 'binary'
							? 'the saved file is not text'
							: 'the saved file is larger than 1 MB',
				});
			},
		},
		file,
		onSaved,
	);
}

/**
 * The source editor for a todo row: complete text, saved exactly as typed
 * through the table's conditional replacement, whether or not it parses. It
 * repairs a row the structured editor refuses, and edits what that editor
 * cannot, such as frontmatter the table does not declare. The row is
 * addressed by its baseline's path, so it follows a rename.
 */
export function createRowSourceEditor(
	table: FileTable<TodoFields>,
	row: SavedText,
	onSaved: () => void,
): TextFileEditor {
	return createDraft(
		{
			async write(baseline, { text }) {
				const stem = rowStemOf(table.name, baseline.path);
				if (stem === undefined)
					return FileError.InvalidPath({
						path: baseline.path,
						reason: `'${baseline.path}' is not a todo row`,
					});
				return table.replace(stem, text, {
					expectedSha256: baseline.sha256,
				});
			},
			async read(baseline) {
				const stem = rowStemOf(table.name, baseline.path);
				if (stem === undefined)
					return Err({ message: `'${baseline.path}' is not a todo row` });
				return table.get(stem);
			},
		},
		row,
		onSaved,
	);
}
