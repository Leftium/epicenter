/**
 * Drafts of ordinary text files, and the policy every draft in a workspace
 * shares.
 *
 * A text draft's `buffer` is the text on screen, including unsaved typing.
 * `baseline` is the saved file the next conditional save is checked against.
 * A save captures one generation of the buffer; its own receipt advances the
 * baseline to the bytes it sent and leaves newer typing dirty. Those bytes'
 * text differs from the typed string where encoding replaced an unpaired
 * surrogate; a buffer still at the generation that was sent becomes that
 * text, so the draft settles. Git outcomes never affect this state.
 *
 * Only a save's own receipt says it landed. A save the folder refused, one
 * that threw, and one whose reply never arrived each stop saving on its own:
 * typing stays in the buffer, nothing is written by a timer, by settling, or
 * by closing, and the baseline stays the file the draft was made on. A read
 * that finds the file holding the draft's text says what the file holds now,
 * not which write put it there, so it never turns an unknown save into a
 * saved one. The person tries again, which is one more conditional save
 * against that same baseline, or reviews the file as it is now.
 *
 * Another writer can change the file while a draft is dirty: the terminal, an
 * editor outside the app, or Git. The draft learns of it either from a folder
 * refresh or from its own refused save, and in both cases it stops saving and
 * holds both versions: the typing stays in the buffer and the saved file is
 * kept beside it for review. Nothing is overwritten until the person chooses
 * to keep theirs, take the saved one, or keep both.
 *
 * Rows of the recordings, transcriptions, and transformations tables are not
 * edited here: one row editor holds each, its fields and its source alike,
 * and saves input as it is typed (`row-editing.svelte.ts`). Autosave and its
 * pause are this module's. A text draft edits any other file.
 */
import type { FolderFiles, TextCapture } from '@epicenter/folder';
import { submittedText } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { readTextFile } from './files.js';

/** One saved text file as its draft last accepted it. */
export type SavedText = TextCapture;

/** Where a draft's saving stands. Every kind but `saved` and `saving` waits for the person. */
type SaveState =
	| { readonly kind: 'saved' }
	| { readonly kind: 'saving' }
	/** The folder refused the save, or the save threw. No save receipt was received. */
	| { readonly kind: 'failed'; readonly message: string }
	/** The save's reply never arrived. It may or may not have landed. */
	| { readonly kind: 'unconfirmed'; readonly message: string }
	| {
			readonly kind: 'conflict';
			readonly message: string;
			/** The saved file now, or undefined when it was removed. */
			readonly current: SavedText | undefined;
	  };

/** Shared by every draft of one workspace. Pausing leaves typing unsaved until asked. */
export type Autosave = { paused: boolean };

/**
 * Whether a draft takes typing and starts writes of its own now. While it
 * does not, the text stays as it is and nothing new is written; a save of
 * typing already taken still runs and settles.
 */
export type Admits = () => boolean;

/** Typing batches for this long before a save; the folder adds no Git delay. */
export const TYPING_BATCH_MS = 400;

const CLOSING = 'Whispering is closing, so nothing was written.';

/** `notes.md` becomes `conflicts/notes-20260102-030405.md`; the folder decides if it is free. */
export function conflictCopyPath(path: string, now = new Date()): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '';
	const stamp = now
		.toISOString()
		.replace(/\.\d+Z$/, '')
		.replace(/[-:]/g, '')
		.replace('T', '-');
	return `conflicts/${stem}-${stamp}${extension}`;
}

/**
 * A draft of one text file whose saves are conditional on the file it was
 * made on, through the folder's own `files.replace`.
 */
export function createTextFileEditor(
	files: FolderFiles,
	file: SavedText,
	autosave: Autosave,
	onSaved: () => void,
	admits: Admits = () => true,
	/**
	 * Whether this draft may write its file now. False while the file is
	 * being moved or deleted: nothing is saved, by a timer, by settling, or by
	 * the person, until it is true again and `resume` is called.
	 */
	writes: () => boolean = () => true,
) {
	let baseline = $state.raw<SavedText>(file);
	let buffer = $state(file.text);
	let saveState = $state.raw<SaveState>({ kind: 'saved' });
	/**
	 * Why an earlier save is not known to have landed, kept after the person
	 * took the file as it is now, until a save of this draft is confirmed.
	 */
	let unknown = $state<string | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	let disposed = false;

	const dirty = () => buffer !== baseline.text;
	/** Whether saving goes on without the person: nothing failed, is unknown, or is in review. */
	const proceeds = () => saveState.kind === 'saved' && !disposed;
	/** Whether a save may be sent now, by a timer or by the person. */
	const sendable = () => !disposed && writes();

	function schedule() {
		clearTimeout(timer);
		timer = undefined;
		if (!proceeds() || !sendable() || autosave.paused) return;
		timer = setTimeout(() => {
			timer = undefined;
			void save();
		}, TYPING_BATCH_MS);
	}

	/** The file at the baseline's path now, for review. Undefined means absent. */
	async function current(): Promise<
		Result<SavedText | undefined, { readonly message: string }>
	> {
		const { data: opened, error: readError } = await readTextFile(
			files,
			baseline.path,
		);
		if (readError !== null)
			return readError.name === 'NotFound' ? Ok(undefined) : Err(readError);
		if (opened.kind === 'text') return Ok(opened.file);
		return Err({
			message:
				opened.kind === 'binary'
					? 'the saved file is not text'
					: 'the saved file is larger than 1 MB',
		});
	}

	/**
	 * Send the buffer once, conditional on the baseline. Only the folder's
	 * receipt advances the baseline. A refusal because the file changed is
	 * read for review; any other outcome is kept as it is, and nothing is
	 * concluded from what the file holds.
	 */
	async function saveOnce() {
		const captured = buffer;
		const submitted = submittedText(captured);
		const observed = baseline;
		saveState = { kind: 'saving' };
		let written: Awaited<ReturnType<FolderFiles['replace']>>;
		try {
			written = await files.replace(
				{ path: observed.path, sha256: observed.sha256 },
				submitted.bytes,
			);
		} catch (cause) {
			saveState = {
				kind: 'failed',
				message: cause instanceof Error ? cause.message : String(cause),
			};
			return;
		}
		const { data: replaced, error } = written;
		if (error === null) {
			baseline = {
				path: observed.path,
				text: submitted.text,
				sha256: replaced.sha256,
			};
			// Newer typing is a later generation and stays as typed.
			if (buffer === captured) buffer = submitted.text;
			saveState = { kind: 'saved' };
			unknown = undefined;
			onSaved();
			return;
		}
		switch (error.name) {
			case 'Unconfirmed':
				saveState = { kind: 'unconfirmed', message: error.message };
				unknown = error.message;
				return;
			case 'Conflict': {
				const { data: savedText, error: readError } = await current();
				saveState =
					readError !== null
						? {
								kind: 'failed',
								message: `This file changed elsewhere, and the saved version cannot be shown: ${readError.message}`,
							}
						: { kind: 'conflict', message: error.message, current: savedText };
				return;
			}
			default:
				saveState = { kind: 'failed', message: error.message };
		}
	}

	/** Run one save, so that only one is ever out. */
	async function run() {
		const once = saveOnce();
		saving = once;
		try {
			await once;
		} finally {
			saving = undefined;
		}
		// Typing that arrived during the save is still dirty; batch it again.
		if (dirty()) schedule();
	}

	/**
	 * Save the current generation now, while saving goes on by itself.
	 * Resolves when no save is running. After a failure, an unknown reply, or
	 * a change in review, this writes nothing.
	 */
	async function save(): Promise<void> {
		clearTimeout(timer);
		timer = undefined;
		if (saving) {
			await saving;
			return proceeds() && sendable() && dirty() ? save() : undefined;
		}
		if (!proceeds() || !sendable() || !dirty()) return;
		await run();
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
		/**
		 * Why an earlier save of this draft is not known to have landed, while
		 * no later save has been confirmed. A file that holds the same text
		 * does not answer it.
		 */
		get unknown() {
			return unknown;
		},
		get dirty() {
			return dirty();
		},
		get path() {
			return baseline.path;
		},
		/** Replace the whole buffer, as a source editor does. */
		input(text: string) {
			if (!admits() || disposed) return;
			buffer = text;
			schedule();
		},
		/**
		 * Take text the draft of this file at its old path already accepted,
		 * when the file moved here. It is not new input, so admission does not
		 * gate it. False once this draft is put down.
		 */
		carry(text: string): boolean {
			if (disposed) return false;
			buffer = text;
			schedule();
			return true;
		},
		save,
		/**
		 * A fresh observation of the saved file. The same bytes only refresh
		 * metadata. Changed bytes are adopted by a clean draft whose saving
		 * goes on by itself. Any other draft never adopts them: it holds both
		 * versions for review, even when the file holds its own text.
		 */
		observe(next: SavedText) {
			if (next.path !== baseline.path) return;
			if (next.sha256 === baseline.sha256) {
				baseline = next;
				return;
			}
			if (saveState.kind === 'conflict') {
				saveState = { ...saveState, current: next };
				return;
			}
			if (saving) return;
			if (dirty() || !proceeds()) {
				clearTimeout(timer);
				timer = undefined;
				saveState = {
					kind: 'conflict',
					message: `The file at '${next.path}' changed after it was read`,
					current: next,
				};
				return;
			}
			baseline = next;
			buffer = next.text;
		},
		/** The saved file is gone. A draft that holds anything keeps its text as a conflict. */
		observeRemoved() {
			if (saving) return;
			if (saveState.kind === 'conflict') {
				saveState = { ...saveState, current: undefined };
				return;
			}
			if (!dirty() && proceeds()) return;
			clearTimeout(timer);
			timer = undefined;
			saveState = {
				kind: 'conflict',
				message: `The file at '${baseline.path}' was removed after it was read`,
				current: undefined,
			};
		},
		/**
		 * Conflict choice: discard my input and take the file as it is now. An
		 * earlier save whose reply was lost stays unknown.
		 */
		loadSaved() {
			if (!admits() || disposed) return;
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			buffer = saveState.current.text;
			saveState = { kind: 'saved' };
		},
		/** Conflict choice: save my input over the version I reviewed, once. */
		async keepMine() {
			if (!admits() || !sendable() || saving) return;
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			await run();
		},
		/**
		 * Conflict choice: write my input to a new file, then take the saved one.
		 * Returns the copy's path, or the reason it could not be written; on a
		 * failure the conflict and my input stay as they were.
		 */
		async keepBoth(): Promise<Result<string, string>> {
			if (!admits() || disposed) return Err(CLOSING);
			if (saveState.kind !== 'conflict')
				return Err('There is no conflict to resolve.');
			const copy = conflictCopyPath(baseline.path);
			const { error: createError } = await files.create(copy, buffer);
			if (createError !== null) return Err(createError.message);
			if (saveState.kind === 'conflict' && saveState.current !== undefined) {
				baseline = saveState.current;
				buffer = saveState.current.text;
				saveState = { kind: 'saved' };
			}
			return Ok(copy);
		},
		/**
		 * After a failed or unknown save, as the person asked: one more
		 * conditional save of the buffer against the baseline the draft was
		 * made on. A file that changed since, this draft's earlier bytes
		 * included, is shown for review instead of being written over.
		 */
		async retry() {
			if (!admits() || !sendable() || saving) return;
			if (saveState.kind !== 'failed' && saveState.kind !== 'unconfirmed')
				return;
			await run();
		},
		/**
		 * Save pending input that can be saved by itself, before the file is
		 * renamed, deleted, or closed. True when the file holds the draft and
		 * nothing waits for the person.
		 */
		async settle(): Promise<boolean> {
			await save();
			return !dirty() && proceeds();
		},
		/** Saving may go on again after writes were held: batch held typing. */
		resume() {
			if (timer === undefined && !saving && dirty()) schedule();
		},
		/** Write nothing more and take no typing. A save already out still settles. */
		dispose() {
			disposed = true;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}

export type TextFileEditor = ReturnType<typeof createTextFileEditor>;
