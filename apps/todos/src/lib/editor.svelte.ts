/**
 * Editors over saved text files (ADR-0465).
 *
 * A draft's `buffer` is the text on screen, including unsaved typing.
 * `baseline` is the saved file the next conditional save is checked against. A
 * save captures one generation of the buffer; success advances the baseline to
 * the accepted file and leaves newer typing dirty. A conflict pauses autosave
 * and keeps the input until the person chooses. A conflict whose saved file
 * cannot be read is a failed save, never a removal. A rename runs through the
 * draft's `move`, which holds saves until the file is at its new path. Git
 * outcomes never affect this state.
 *
 * Todo rows save through their table; other text files save through raw
 * conditional replacements. Both use this one draft, so the retained-draft and
 * conflict rules are the same for every file the app edits.
 */
import {
	type Entry,
	type FileCapture,
	type FileTable,
	type FolderFiles,
	patchSource,
	type SourceChange,
	type TextCapture,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import { readTextFile } from './files.js';

export type TodoEntry = Entry<TodoFields>;

/**
 * One saved text file as its draft last accepted it: the capture the next
 * conditional save is checked against, with the text those bytes decode to.
 */
export type SavedText = TextCapture;

export type SaveState<T> =
	| { readonly kind: 'saved' }
	| { readonly kind: 'saving' }
	| { readonly kind: 'failed'; readonly message: string }
	| {
			readonly kind: 'conflict';
			readonly message: string;
			/** The saved file now, or undefined when it was removed. */
			readonly current: T | undefined;
	  };

/** Where a draft saves: one conditional write, and a fresh read for conflict review. */
type DraftStore<T extends SavedText> = {
	write(
		baseline: T,
		source: string,
	): Promise<Result<T, { readonly name: string; readonly message: string }>>;
	/**
	 * The saved file now. Only absence is `undefined`; a file that could not be
	 * read, or is no longer editable text, is an error and never reads as removed.
	 * The baseline names the file: a row by its stem, a raw file by its path.
	 */
	read(
		baseline: T,
	): Promise<Result<T | undefined, { readonly message: string }>>;
};

/** Typing batches for this long before a save; the folder adds no Git delay. */
const TYPING_BATCH_MS = 400;

export type Draft<T extends SavedText> = ReturnType<typeof createDraft<T>>;
export type TodoEditor = Draft<TodoEntry>;
export type TextFileEditor = Draft<SavedText>;

function createDraft<T extends SavedText>(
	store: DraftStore<T>,
	initial: T,
	onSaved: () => void,
) {
	let baseline = $state.raw<T>(initial);
	let buffer = $state(initial.source);
	let saveState = $state.raw<SaveState<T>>({ kind: 'saved' });
	let refusal = $state<string | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	/** Pending while a rename owns the file's path; resolves when it settles. */
	let moving: Promise<void> | undefined;

	const dirty = () => buffer !== baseline.source;

	function schedule() {
		clearTimeout(timer);
		if (saveState.kind === 'conflict' || moving) return;
		timer = setTimeout(() => void save(), TYPING_BATCH_MS);
	}

	function input(text: string) {
		buffer = text;
		refusal = undefined;
		schedule();
	}

	async function saveOnce() {
		const captured = buffer;
		const observed = baseline;
		saveState = { kind: 'saving' };
		try {
			const result = await store.write(observed, captured);
			if (result.error === null) {
				baseline = result.data;
				saveState = { kind: 'saved' };
				onSaved();
				return;
			}
			if (result.error.name !== 'Conflict') {
				saveState = { kind: 'failed', message: result.error.message };
				return;
			}
			const current = await store.read(observed);
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
		} catch (cause) {
			// A store that throws (its host went away mid-call) must not leave the
			// draft saving forever. The baseline and the input stay for a retry.
			saveState = {
				kind: 'failed',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}

	/** Run admitted saves to completion. A move drains through here before it runs. */
	async function drain(): Promise<void> {
		clearTimeout(timer);
		if (saveState.kind === 'conflict') return;
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
	 * Save the current generation now. Resolves when no save is running. A
	 * move holds saves: this returns at once, the input stays dirty, and it
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
		/** Why the last structured change was refused; typing clears it. */
		get refusal() {
			return refusal;
		},
		get dirty() {
			return dirty();
		},
		get path() {
			return baseline.path;
		},
		/** Replace the whole buffer, as a source editor does. */
		input,
		/** Record that a requested change could not be applied; the buffer is unchanged. */
		refuse(reason: string) {
			refusal = reason;
		},
		save,
		/**
		 * Same-byte observations adopt the newer observation without replacing input.
		 * Changed bytes are adopted only by a clean, idle draft; a dirty draft
		 * keeps its sha256 so its next save detects the other writer.
		 */
		observe(next: T) {
			if (next.path !== baseline.path) return;
			if (next.sha256 === baseline.sha256) {
				baseline = next;
				return;
			}
			if (dirty() || saving || moving || saveState.kind !== 'saved') return;
			baseline = next;
			buffer = next.source;
		},
		/** Conflict choice: discard my input and load the saved file. */
		loadSaved() {
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			buffer = saveState.current.source;
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
		async retry() {
			if (saveState.kind === 'failed') saveState = { kind: 'saved' };
			await save();
		},
		/**
		 * Settle pending input before the file is deleted or closed. Waits for a
		 * running move, then for the saves it held.
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
			run: (settled: T) => Promise<Result<T, string>>,
		): Promise<Result<T, string> | undefined> {
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
					if (!wasDirty) buffer = result.data.source;
				}
				return result;
			} finally {
				moving = undefined;
				finish();
				if (dirty() && saveState.kind === 'saved') schedule();
			}
		},
		dispose() {
			clearTimeout(timer);
		},
	};
}

export function createTodoEditor(
	table: FileTable<TodoFields>,
	entry: TodoEntry,
	onSaved: () => void,
): TodoEditor {
	return createDraft<TodoEntry>(
		{
			write: (baseline, source) => table.replace(baseline, source),
			read: (baseline) => table.get(baseline.stem),
		},
		entry,
		onSaved,
	);
}

/**
 * A text file editor whose conditional saves follow the folder's history
 * policy. A save replaces the baseline's captured bytes, and the capture it
 * returns, computed from the text that was sent, is the next baseline.
 */
export function createTextFileEditor(
	files: FolderFiles,
	file: SavedText,
	onSaved: () => void,
): TextFileEditor {
	return createDraft<SavedText>(
		{
			async write(baseline, source) {
				const replaced = await files.replace(baseline, source);
				if (replaced.error) return Err(replaced.error);
				return Ok({ ...replaced.data, source });
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
 * Change frontmatter fields or the body with the preparation table updates
 * use. Source the preparation cannot change safely is refused and kept as typed.
 */
export function patchTodo(
	editor: TodoEditor | TextFileEditor,
	change: SourceChange,
): boolean {
	const patched = patchSource(editor.buffer, change);
	if (patched.error) {
		editor.refuse(patched.error.reason);
		return false;
	}
	editor.input(patched.data);
	return true;
}
