/**
 * Editors over saved text files.
 *
 * A draft's `buffer` is the text on screen, including unsaved typing.
 * `baseline` is the saved file the next conditional save is checked against. A
 * save captures one generation of the buffer; success advances the baseline to
 * the accepted file and leaves newer typing dirty. Git outcomes never affect
 * this state.
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
	type Entry,
	type FileTable,
	type FileVersion,
	type FolderFiles,
	patchSource,
	type SourceChange,
	sameVersion,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	RECORDINGS,
	type RecordingFields,
	type TransformationFields,
} from './definition.js';
import { readTextFile } from './files.js';

export type RecordingEntry = Entry<RecordingFields>;

/** One saved text file as its draft last accepted it. */
export type SavedText = {
	readonly path: string;
	readonly source: string;
	readonly version: FileVersion;
};

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
	/** Undefined means absent; an unreadable saved file remains a failure. */
	read(
		path: string,
	): Promise<Result<T | undefined, { readonly message: string }>>;
	/** Save text as a new file beside the conflict; returns the path it wrote. */
	keepCopy(path: string, source: string): Promise<Result<string, string>>;
};

/** Shared by every draft of one workspace. Pausing leaves typing unsaved until asked. */
export type Autosave = { paused: boolean };

/** Typing batches for this long before a save; the folder adds no Git delay. */
const TYPING_BATCH_MS = 400;

export type Draft<T extends SavedText> = ReturnType<typeof createDraft<T>>;
export type RowEditor<TFields> = Draft<Entry<TFields>>;
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
			if (
				result.error.name === 'Conflict' ||
				result.error.name === 'Unconfirmed'
			) {
				const current = await store.read(observed.path);
				if (current.error === null && current.data?.source === captured) {
					baseline = current.data;
					saveState = { kind: 'saved' };
					onSaved();
					return;
				}
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
			if (sameVersion(next.version, baseline.version)) {
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
	entry: Entry<TFields>,
	autosave: Autosave,
	onSaved: () => void,
): RowEditor<TFields> {
	return createDraft<Entry<TFields>>(
		{
			write: (baseline, source) => table.replace(baseline, source),
			read: (path) =>
				table.get(path.slice(table.name.length + 1, -'.md'.length)),
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
			async write(baseline, source) {
				const written = await files.replace(
					{ path: baseline.path, version: baseline.version },
					source,
				);
				if (written.error) return Err(written.error);
				return Ok({
					path: baseline.path,
					source,
					version: written.data.version,
				});
			},
			async read(path) {
				const read = await readTextFile(files, path);
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
 * use. Source the preparation cannot change safely is refused and kept as typed.
 */
export function patchRow(
	editor: Pick<TextFileEditor, 'buffer' | 'input' | 'refuse'>,
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

export function stemOf(path: string): string {
	return path.slice(RECORDINGS.length + 1, -'.md'.length);
}
