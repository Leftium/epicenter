/**
 * Editors over saved text files.
 *
 * A draft's `buffer` is the text on screen, including unsaved typing.
 * `baseline` is the saved file the next conditional save is checked against. A
 * save captures one generation of the buffer; success advances the baseline to
 * the accepted file and leaves newer typing dirty. The accepted file holds the
 * text of the bytes that were sent, which differs from the typed string where
 * encoding replaced an unpaired surrogate; a buffer still at the generation
 * that was sent becomes that text, so the draft settles. Git outcomes never
 * affect this state.
 *
 * Another writer can change the file while a draft is dirty: the terminal, an
 * editor outside the app, or Git. The draft learns of it either from a folder
 * refresh or from its own refused save, and in both cases it stops saving and
 * holds both versions: the typing stays in the buffer and the saved file is
 * kept beside it for review. Nothing is overwritten until the person chooses
 * to keep theirs, take the saved one, or keep both.
 *
 * A row's details and its Source view are two views of one draft, so an edit
 * in either is the same unsaved text. Recordings and transformations both edit
 * this way.
 */
import {
	type FileTable,
	type FolderFiles,
	patchSource,
	type SourceChange,
	type TableSnapshot,
	type TextCapture,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type RecordingFields,
	type TransformationFields,
} from './definition.js';
import { readTextFile, type SubmittedText, submittedText } from './files.js';

export type RecordingEntry = TableSnapshot<RecordingFields>;

/** One saved text file as its draft last accepted it. */
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
	/** The accepted file's `source` is the text of the submitted bytes. */
	write(
		baseline: T,
		submitted: SubmittedText,
	): Promise<Result<T, { readonly name: string; readonly message: string }>>;
	/**
	 * The saved file the baseline names, now: a row by its stem, a raw file by
	 * its path. Undefined means absent; an unreadable saved file remains a failure.
	 */
	read(
		baseline: T,
	): Promise<Result<T | undefined, { readonly message: string }>>;
	/** Save text as a new file beside the conflict; returns the path it wrote. */
	keepCopy(path: string, source: string): Promise<Result<string, string>>;
};

/** Shared by every draft of one workspace. Pausing leaves typing unsaved until asked. */
export type Autosave = { paused: boolean };

/** Typing batches for this long before a save; the folder adds no Git delay. */
const TYPING_BATCH_MS = 400;

export type Draft<T extends SavedText> = ReturnType<typeof createDraft<T>>;
export type RowEditor<TFields> = Draft<TableSnapshot<TFields>>;
export type RecordingEditor = RowEditor<RecordingFields>;
export type TransformationEditor = RowEditor<TransformationFields>;
export type TextFileEditor = Draft<SavedText>;

function createDraft<T extends SavedText>(
	store: DraftStore<T>,
	initial: T,
	autosave: Autosave,
	onSaved: () => void,
) {
	let baseline = $state.raw<T>(initial);
	let buffer = $state(initial.source);
	let saveState = $state.raw<SaveState<T>>({ kind: 'saved' });
	let refusal = $state<string | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;

	const dirty = () => buffer !== baseline.source;

	function schedule() {
		clearTimeout(timer);
		if (saveState.kind === 'conflict' || autosave.paused) return;
		timer = setTimeout(() => void save(), TYPING_BATCH_MS);
	}

	function input(text: string) {
		buffer = text;
		refusal = undefined;
		schedule();
	}

	async function saveOnce() {
		const captured = buffer;
		const submitted = submittedText(captured);
		const observed = baseline;
		/**
		 * The file holds the text of the submitted bytes. That is the captured
		 * text unless encoding replaced an unpaired surrogate. Newer typing is
		 * a later generation and stays as typed.
		 */
		const accept = (saved: T) => {
			baseline = saved;
			if (buffer === captured) buffer = saved.source;
			saveState = { kind: 'saved' };
			onSaved();
		};
		saveState = { kind: 'saving' };
		try {
			const result = await store.write(observed, submitted);
			if (result.error === null) return accept(result.data);
			if (
				result.error.name === 'Conflict' ||
				result.error.name === 'Unconfirmed'
			) {
				const current = await store.read(observed);
				// The file holding exactly the submitted text is this save, landed.
				if (
					current.error === null &&
					current.data?.source === submitted.source
				)
					return accept(current.data);
				if (result.error.name === 'Conflict') {
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
					return;
				}
			}
			saveState = { kind: 'failed', message: result.error.message };
		} catch (cause) {
			saveState = {
				kind: 'failed',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}

	/** Save the current generation now. Resolves when no save is running. */
	async function save(): Promise<void> {
		clearTimeout(timer);
		if (saveState.kind === 'conflict') return;
		if (saving) {
			await saving;
			return dirty() ? save() : undefined;
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
		 * A fresh observation of the saved file. The same bytes only refresh
		 * metadata. Changed bytes are adopted by a clean, idle draft. A dirty
		 * draft never adopts them: it stops saving and holds both versions.
		 */
		observe(next: T) {
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
			if (dirty() || saveState.kind === 'failed') {
				clearTimeout(timer);
				saveState = {
					kind: 'conflict',
					message: `The file at '${next.path}' changed after it was read`,
					current: next,
				};
				return;
			}
			baseline = next;
			buffer = next.source;
		},
		/** The saved file is gone. A dirty draft keeps its text as a conflict. */
		observeRemoved() {
			if (saving) return;
			if (saveState.kind === 'conflict') {
				saveState = { ...saveState, current: undefined };
				return;
			}
			if (!dirty() && saveState.kind === 'saved') return;
			clearTimeout(timer);
			saveState = {
				kind: 'conflict',
				message: `The file at '${baseline.path}' was removed after it was read`,
				current: undefined,
			};
		},
		/** Conflict choice: discard my input and load the saved file. */
		loadSaved() {
			if (saveState.kind !== 'conflict' || saveState.current === undefined)
				return;
			baseline = saveState.current;
			buffer = saveState.current.source;
			saveState = { kind: 'saved' };
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
		 * Conflict choice: write my input to a new file, then load the saved one.
		 * Returns the copy's path, or the reason it could not be written; on a
		 * failure the conflict and my input stay as they were.
		 */
		async keepBoth(): Promise<Result<string, string>> {
			if (saveState.kind !== 'conflict')
				return Err('There is no conflict to resolve.');
			const copied = await store.keepCopy(baseline.path, buffer);
			if (copied.error !== null) return copied;
			if (saveState.kind === 'conflict' && saveState.current !== undefined) {
				baseline = saveState.current;
				buffer = saveState.current.source;
				saveState = { kind: 'saved' };
			}
			return copied;
		},
		async retry() {
			if (saveState.kind === 'failed') saveState = { kind: 'saved' };
			await save();
		},
		/** Settle pending input before the file is renamed, deleted, or closed. */
		async settle(): Promise<boolean> {
			await save();
			return !dirty() && saveState.kind === 'saved';
		},
		dispose() {
			clearTimeout(timer);
		},
	};
}

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

function copyKeeper(files: FolderFiles): DraftStore<SavedText>['keepCopy'] {
	return async (path, source) => {
		const copy = conflictCopyPath(path);
		const written = await files.create(copy, source);
		return written.error ? Err(written.error.message) : Ok(copy);
	};
}

/**
 * An editor over one table row's Markdown source: a recording or a
 * transformation. Saves are conditional writes of the whole source through the
 * row's table, so fields the app does not know are kept as written.
 */
export function createRowEditor<TFields>(
	table: FileTable<TFields>,
	files: FolderFiles,
	entry: TableSnapshot<TFields>,
	autosave: Autosave,
	onSaved: () => void,
): RowEditor<TFields> {
	return createDraft<TableSnapshot<TFields>>(
		{
			write: (baseline, { source }) => table.replace(baseline, source),
			read: (baseline) => table.get(baseline.stem),
			keepCopy: copyKeeper(files),
		},
		entry,
		autosave,
		onSaved,
	);
}

/** A text file editor whose conditional saves follow the folder's history policy. */
export function createTextFileEditor(
	files: FolderFiles,
	file: SavedText,
	autosave: Autosave,
	onSaved: () => void,
): TextFileEditor {
	return createDraft<SavedText>(
		{
			async write(baseline, { bytes, source }) {
				const written = await files.replace(
					{ path: baseline.path, sha256: baseline.sha256 },
					bytes,
				);
				if (written.error) return Err(written.error);
				return Ok({
					path: baseline.path,
					source,
					sha256: written.data.sha256,
				});
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
			keepCopy: copyKeeper(files),
		},
		file,
		autosave,
		onSaved,
	);
}

/**
 * Change frontmatter fields or the body with the preparation table updates
 * use. A buffer that does not parse, or that the preparation cannot change
 * safely, is refused and kept as typed: the Source view is how it is fixed.
 */
export function patchRow(
	editor: Pick<TextFileEditor, 'buffer' | 'input' | 'refuse'>,
	change: SourceChange,
): boolean {
	const patched = patchSource(editor.buffer, change);
	if (patched.error) {
		editor.refuse(
			patched.error.kind === 'unparsed'
				? patched.error.error.message
				: patched.error.reason,
		);
		return false;
	}
	editor.input(patched.data);
	return true;
}
