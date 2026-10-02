/**
 * The Whispering product state over one opened workspace.
 *
 * Everything shown is an observation of the folder's current files: the
 * recording rows, their transcription results, the transformations and their
 * results, the settings in `kv.json`, and the listing the file browser shows.
 * They refresh together after saves, terminal commands, window focus, and any
 * change another program makes. A selection is a path; editors are retained
 * per path so a selection change never discards a draft.
 *
 * Three things live only in this window until they reach the folder: unsaved
 * typing, captured audio that has not been fully published, and text an
 * endpoint returned whose file is not written yet. All are kept across
 * failures and all block leaving the app.
 *
 * Git status comes from the folder's shared snapshot; this module adds no
 * status cache of its own. A save and its commit are separate outcomes.
 */
import type {
	CommitOutcome,
	Entry,
	FileListing,
	GitSnapshot,
	KvSnapshot,
	TableWriteError,
} from '@epicenter/folder';
import { rowPath, rowStemOf } from '@epicenter/folder';
import { customAlphabet } from 'nanoid';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import type { ActiveCapture, CapturedAudio } from './capture.js';
import {
	audioPathIn,
	RECORDINGS,
	type RecordingFields,
	recordingAudioPath,
	TRANSCRIPTIONS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TranscriptionSettings,
	type TransformationFields,
	type TransformationRunFields,
} from './definition.js';
import {
	type Autosave,
	createRowEditor,
	createTextFileEditor,
	type RecordingEditor,
	type RecordingEntry,
	type TextFileEditor,
	type TransformationEditor,
} from './editor.svelte.js';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
	nameProblem,
	readTextFile,
} from './files.js';
import {
	type ConfirmedPublication,
	observePublication,
	type PendingCapture,
	publishRecording,
} from './recordings/publish.js';
import { createTerminalSession } from './terminal.svelte.js';
import type { Workspace } from './workspace/index.js';

export type Library = ReturnType<typeof createLibrary>;
export type TranscriptionEntry = Entry<TranscriptionFields>;
export type TransformationEntry = Entry<TransformationFields>;
export type TransformationRunEntry = Entry<TransformationRunFields>;

/** A raw file the person opened. Recording and transformation rows open as row editors instead. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: TextFileEditor }
	| { readonly kind: 'audio'; readonly size: number }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

export type Selection =
	| {
			readonly kind: 'recording';
			readonly editor: RecordingEditor;
			/** The listed row, or undefined when the file left the folder. */
			readonly entry: RecordingEntry | undefined;
	  }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| {
			readonly kind: 'recording';
			/** The row that is deleted. The audio it names is a separate file and stays. */
			readonly entry: RecordingEntry;
			readonly results: readonly TranscriptionEntry[];
			/** Transformation results made from this recording's transcripts. */
			readonly outputs: readonly TransformationRunEntry[];
	  }
	| {
			readonly kind: 'transformation';
			readonly entry: TransformationEntry;
			/** How many saved results name it. They are kept. */
			readonly results: number;
	  }
	| {
			readonly kind: 'file';
			readonly path: string;
			readonly sha256: string;
	  }
	| { readonly kind: 'folder'; readonly path: string };

/**
 * A capture the window still holds: its fixed id and bytes, and where its
 * publication stands. Every state but `published` is unresolved: the
 * recording is not known to be in the folder, and the bytes here are what
 * would be lost. `published` is resolved as a save and open only as a display
 * question.
 */
export type PendingRecording = {
	readonly capture: PendingCapture;
	readonly mimeType: string;
	readonly attempts: number;
	readonly state:
		| { readonly kind: 'saving' }
		/**
		 * A complete receipt confirmed both files were published. The row could
		 * not then be shown as this recording: the read failed, or another writer
		 * removed or changed it afterward. Nothing is unsaved. The only thing
		 * done from here is to read the row again; nothing is published again and
		 * nothing is recreated. No entry is made from `publication`.
		 */
		| {
				readonly kind: 'published';
				readonly publication: ConfirmedPublication;
				readonly problem: 'unreadable' | 'missing' | 'foreign';
				readonly message: string;
				/** Whether the row is being read again now. */
				readonly checking: boolean;
		  }
		/**
		 * The last attempt failed or was not confirmed. It may have written
		 * nothing, or its reply or read-back may have been lost after it wrote.
		 */
		| { readonly kind: 'failed'; readonly message: string }
		/** The audio file is saved; the recording's row is not. */
		| {
				readonly kind: 'partial';
				readonly message: string;
				readonly landed: readonly string[];
		  }
		/** The folder holds something at this recording's paths that is not its own; nothing was overwritten. */
		| {
				readonly kind: 'unexpected';
				readonly message: string;
				readonly path: string;
		  };
};

export type RecorderState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'starting' }
	| { readonly phase: 'recording'; readonly startedAt: number }
	| { readonly phase: 'stopping' };

/**
 * A transcript the endpoint returned. `id` is the result row's stem, `fields`
 * is exactly what the row will hold, and `body` is exactly the row's body;
 * all are fixed when the answer arrives, so every save lands in the same file
 * and never makes a second result.
 */
type ReceivedTranscript = {
	readonly id: string;
	readonly fields: TranscriptionFields;
	/** The answer as received: what is shown and copied. */
	readonly text: string;
	readonly body: string;
};

/** One transcription request for a recording, until its result row is saved. */
export type TranscriptionRun =
	/** The request is out, or its answer is being written for the first time. */
	| { readonly kind: 'running' }
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * The endpoint answered, and the result row is not known to be in the
	 * folder: the write was refused, or its reply was lost after it may have
	 * landed. `saving` is true while a save of it is under way; no second save
	 * starts until that one ends.
	 */
	| (ReceivedTranscript & {
			readonly kind: 'unsaved';
			readonly message: string;
			readonly saving: boolean;
	  });

/**
 * One application of a transformation to a transcript, until its result row
 * is saved. `id` is the result row's stem and `fields` is exactly what the row
 * will hold; both are fixed when the run starts, so a retry of either the
 * request or the save lands in the same file and never makes a second result.
 */
export type TransformationRun = {
	readonly id: string;
	readonly fields: TransformationRunFields;
	readonly state:
		| { readonly kind: 'running' }
		/** Nothing was received. Trying again sends the same request. */
		| { readonly kind: 'failed'; readonly message: string }
		/** The endpoint answered, but the result row could not be written. */
		| {
				readonly kind: 'unsaved';
				readonly message: string;
				readonly text: string;
		  };
};

const UNSETTLED = 'Save or discard the open edits first.';
const RECORDING_NAME =
	'A recording’s file is named by its ID, which its transcription results refer to. Change the title instead.';
const RECORDING_AUDIO_NAME =
	'A recording names this audio file in its audioPath field, so renaming it here would leave that recording without audio. Change the recording’s title instead.';
const TRANSFORMATION_NAME =
	'A transformation’s file is named by its ID, which its saved results refer to. Change the title instead.';

const suffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 4);

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** A sortable id from the capture time: `20260102-030405-k3f9`. */
export function recordingId(at: Date): string {
	const stamp = at
		.toISOString()
		.replace(/\.\d+Z$/, '')
		.replace(/[-:]/g, '')
		.replace('T', '-');
	return `${stamp}-${suffix()}`;
}

function defaultTitle(at: Date): string {
	return `Recording ${at.toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	})}`;
}

/** Library errors state failures precisely; these are the ones a person acts on. */
function describeWriteError(error: TableWriteError): string {
	if (error.name === 'Exists')
		return `"${basename(error.path)}" already exists here.`;
	if (error.name === 'Conflict')
		return error.actualSha256 === undefined
			? 'The file is no longer here. Nothing was changed. Check it and try again.'
			: 'The file has different content now. Nothing was changed. Check it and try again.';
	if (error.name === 'DirectoryNotEmpty')
		return 'The folder is not empty, so nothing was deleted.';
	return error.message;
}

/** A received answer as its row's body: the text, ending in one newline of its own. */
const resultBody = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/**
 * Whether a row already at a result's path is that result's own: a valid row
 * with the same body and every field that was fixed for it. A row that differs
 * in any of them (another prompt, model, endpoint, transcript, or source) is
 * someone else's file. Fields the app does not declare are not part of what
 * was fixed, so extra ones do not make it a different result.
 */
function isThisResult<TFields extends object>(
	existing: Entry<TFields>,
	fields: TFields,
	body: string,
): boolean {
	if (existing.issues !== undefined || existing.body !== body) return false;
	const saved: Readonly<Record<string, unknown>> = existing.fields;
	return Object.entries(fields).every(([key, value]) => saved[key] === value);
}

export function createLibrary(workspace: Workspace) {
	const { folder } = workspace;
	let closing = false;
	/** Each caller owns its result; this promise joins accepted file commands. */
	let fileChanges: Promise<void> = Promise.resolve();
	function submitFileChange<TArgs extends unknown[]>(
		work: (...args: TArgs) => Promise<string | undefined>,
	) {
		return (...args: TArgs): Promise<string | undefined> => {
			if (closing) return Promise.resolve('The library is closing.');
			const submitted = structuredClone(args);
			const running = work(...submitted);
			fileChanges = Promise.allSettled([fileChanges, running]).then(() => {});
			return running;
		};
	}

	const table = folder.tables.recordings;
	const results = folder.tables.transcriptions;
	const profiles = folder.tables.transformations;
	const outputs = folder.tables.transformation_runs;

	let entries = $state.raw<RecordingEntry[]>([]);
	let transcriptions = $state.raw<TranscriptionEntry[]>([]);
	let unreadable = $state.raw<{ path: string; message: string }[]>([]);
	let listError = $state<string | undefined>();
	let transformations = $state.raw<TransformationEntry[]>([]);
	let transformationResults = $state.raw<TransformationRunEntry[]>([]);
	let unreadableTransformations = $state.raw<
		{ path: string; message: string }[]
	>([]);
	let transformationsError = $state<string | undefined>();
	let selectedTransformationPath = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	let git = $state.raw<GitSnapshot>(folder.git.snapshot);
	let kv = $state.raw<KvSnapshot<TranscriptionSettings> | undefined>();
	let settingsError = $state<string | undefined>();
	let selectedPath = $state<string | undefined>();
	let pending = $state.raw<PendingRecording[]>([]);
	let recorder = $state.raw<RecorderState>({ phase: 'idle' });
	let recorderError = $state<string | undefined>();
	let credentialPresent = $state(false);
	let active: ActiveCapture | undefined;
	let refreshSequence = 0;
	/**
	 * Transcripts whose publication was confirmed and that no applied listing
	 * has accounted for yet, by path. `transcriptions` is an observation and
	 * lags a save, or misses it when the read fails; a deletion counts these
	 * as the recording's results from the moment they are saved.
	 */
	const unlistedResults = new Map<string, TranscriptionEntry>();
	/** Counts completed folder refreshes; audio players recheck their file on each. */
	let generation = $state(0);
	const autosave = $state<Autosave>({ paused: false });

	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([RECORDINGS]);
	const recordingEditors = new SvelteMap<string, RecordingEditor>();
	const openFiles = new SvelteMap<string, OpenFile>();
	const runs = new SvelteMap<string, TranscriptionRun>();
	const transformationEditors = new SvelteMap<string, TransformationEditor>();
	/** Keyed by the result row's stem. */
	const transformationRuns = new SvelteMap<string, TransformationRun>();

	const rowPaths = $derived(new Set(entries.map((entry) => entry.path)));
	const transformationPaths = $derived(
		new Set(transformations.map((entry) => entry.path)),
	);
	const settings = $derived<TranscriptionSettings>({
		...workspace.initialSettings,
		...kv?.values,
	});
	const selection = $derived.by((): Selection | undefined => {
		if (selectedPath === undefined) return undefined;
		const editor = recordingEditors.get(selectedPath);
		if (editor !== undefined)
			return {
				kind: 'recording',
				editor,
				entry: entries.find((entry) => entry.path === selectedPath),
			};
		const file = openFiles.get(selectedPath);
		return file && { kind: 'file', path: selectedPath, file };
	});

	const terminal = createTerminalSession(workspace.terminal, refreshAll);
	const unsubscribe = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	const unwatch = workspace.onExternalChange(() => void refreshAll());

	function textEditorAt(path: string): TextFileEditor | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'text' ? file.editor : undefined;
	}

	function allEditors(): (
		| RecordingEditor
		| TransformationEditor
		| TextFileEditor
	)[] {
		const editors: (RecordingEditor | TransformationEditor | TextFileEditor)[] =
			[...recordingEditors.values(), ...transformationEditors.values()];
		for (const file of openFiles.values())
			if (file.kind === 'text') editors.push(file.editor);
		return editors;
	}

	/** Newest first; a row whose time cannot be read sorts by its file name. */
	function sortEntries(list: readonly RecordingEntry[]) {
		const key = (entry: RecordingEntry) =>
			typeof entry.fields.recordedAt === 'string'
				? entry.fields.recordedAt
				: '';
		return [...list].sort(
			(a, b) =>
				key(b).localeCompare(key(a)) ||
				(a.path < b.path ? 1 : a.path > b.path ? -1 : 0),
		);
	}

	/** Show newer saved text in open files, and forget clean files that left the folder. */
	async function observeOpenFiles(current: FileListing, sequence: number) {
		const present = new Map(
			current.files.map((file) => [file.path, file.size]),
		);
		for (const [path, file] of openFiles) {
			if (sequence !== refreshSequence) return;
			if (file.kind === 'loading') continue;
			if (file.kind !== 'text') {
				const size = present.get(path);
				if (size === undefined) openFiles.delete(path);
				else if (file.kind !== 'failed' && size !== file.size)
					openFiles.set(path, { ...file, size });
				continue;
			}
			if (!present.has(path)) {
				const idle =
					!file.editor.dirty && file.editor.saveState.kind === 'saved';
				if (idle) {
					file.editor.dispose();
					openFiles.delete(path);
				} else file.editor.observeRemoved();
				continue;
			}
			const read = await readTextFile(folder.files, path);
			if (sequence !== refreshSequence) return;
			if (read.data?.kind === 'text') file.editor.observe(read.data.file);
		}
	}

	/** By title; a row whose title cannot be read sorts by its file name. */
	function sortTransformations(list: readonly TransformationEntry[]) {
		const key = (entry: TransformationEntry) =>
			typeof entry.fields.title === 'string' && entry.fields.title !== ''
				? entry.fields.title
				: entry.path;
		return [...list].sort(
			(a, b) =>
				key(a).localeCompare(key(b), undefined, { sensitivity: 'base' }) ||
				(a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
	}

	async function refresh() {
		const sequence = ++refreshSequence;
		// Published before this read began, so this read's listing accounts for them.
		const published = new Map(unlistedResults);
		const [rows, found, files, kvRead, profileRows, outputRows] =
			await Promise.all([
				table.list(),
				results.list(),
				folder.files.list(),
				folder.kv.get(),
				profiles.list(),
				outputs.list(),
			]);
		if (sequence !== refreshSequence) return;
		if (profileRows.error) {
			transformationsError = profileRows.error.message;
		} else {
			transformationsError = undefined;
			transformations = sortTransformations(profileRows.data.entries);
			unreadableTransformations = profileRows.data.unreadable.map((item) => ({
				path: item.path,
				message: item.error.message,
			}));
			for (const entry of profileRows.data.entries)
				transformationEditors.get(entry.path)?.observe(entry);
			const present = new Set([
				...profileRows.data.entries.map((entry) => entry.path),
				...profileRows.data.unreadable.map((entry) => entry.path),
			]);
			for (const [path, editor] of transformationEditors) {
				if (present.has(path)) continue;
				if (!editor.dirty && editor.saveState.kind === 'saved') forget(path);
				else editor.observeRemoved();
			}
		}
		if (outputRows.error === null)
			transformationResults = [...outputRows.data.entries];
		if (rows.error) {
			// Keep the previous observation visible; never show an empty list for a failed read.
			listError = rows.error.message;
		} else {
			listError = undefined;
			entries = sortEntries(rows.data.entries);
			unreadable = rows.data.unreadable.map((item) => ({
				path: item.path,
				message: item.error.message,
			}));
			for (const entry of rows.data.entries)
				recordingEditors.get(entry.path)?.observe(entry);
			const present = new Set([
				...rows.data.entries.map((entry) => entry.path),
				...rows.data.unreadable.map((entry) => entry.path),
			]);
			for (const [path, editor] of recordingEditors) {
				if (present.has(path)) continue;
				if (!editor.dirty && editor.saveState.kind === 'saved') forget(path);
				else editor.observeRemoved();
			}
		}
		if (found.error === null) {
			transcriptions = [...found.data.entries];
			for (const [path, entry] of published)
				if (unlistedResults.get(path) === entry) unlistedResults.delete(path);
		}
		if (kvRead.error) settingsError = kvRead.error.message;
		else {
			settingsError = undefined;
			kv = kvRead.data;
		}
		if (files.error) {
			listingError = files.error.message;
		} else {
			listingError = undefined;
			listing = files.data;
			await observeOpenFiles(files.data, sequence);
		}
		if (sequence === refreshSequence) generation += 1;
	}

	async function refreshAll() {
		await Promise.all([refresh(), folder.git.status()]);
	}

	function editorFor(entry: RecordingEntry): RecordingEditor {
		let editor = recordingEditors.get(entry.path);
		if (editor === undefined) {
			editor = createRowEditor(
				table,
				folder.files,
				entry,
				autosave,
				() => void refresh(),
			);
			recordingEditors.set(entry.path, editor);
		}
		return editor;
	}

	function transformationEditorFor(
		entry: TransformationEntry,
	): TransformationEditor {
		let editor = transformationEditors.get(entry.path);
		if (editor === undefined) {
			editor = createRowEditor(
				profiles,
				folder.files,
				entry,
				autosave,
				() => void refresh(),
			);
			transformationEditors.set(entry.path, editor);
		}
		return editor;
	}

	/**
	 * Select a path: a recording or transformation row opens its editor, audio
	 * opens a player, other files open as text or details. A transformation has
	 * its own selection, so opening one leaves the selected recording alone.
	 */
	async function open(path: string) {
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		if (rowStemOf(TRANSFORMATIONS, path) !== undefined) {
			let profile = transformations.find((item) => item.path === path);
			if (profile === undefined && !transformationEditors.has(path)) {
				// The list may predate a row written by the terminal or another program.
				await refresh();
				profile = transformations.find((item) => item.path === path);
			}
			if (profile !== undefined) transformationEditorFor(profile);
			if (transformationEditors.has(path)) {
				selectedTransformationPath = path;
				return;
			}
			// Not a readable row: fall through and show it as a raw file.
		}
		selectedPath = path;
		const known = openFiles.get(path);
		if (
			recordingEditors.has(path) ||
			known?.kind === 'text' ||
			known?.kind === 'loading'
		)
			return;
		let entry = entries.find((item) => item.path === path);
		if (entry === undefined && rowStemOf(RECORDINGS, path) !== undefined) {
			// The list may predate a row written by the terminal or another program.
			await refresh();
			entry = entries.find((item) => item.path === path);
		}
		if (entry !== undefined) {
			editorFor(entry);
			return;
		}
		if (audioMimeTypeOf(path) !== undefined) {
			const size = listing?.files.find((file) => file.path === path)?.size ?? 0;
			openFiles.set(path, { kind: 'audio', size });
			return;
		}
		openFiles.set(path, { kind: 'loading' });
		const read = await readTextFile(folder.files, path);
		if (openFiles.get(path)?.kind !== 'loading') return;
		openFiles.set(
			path,
			read.error
				? { kind: 'failed', message: read.error.message }
				: read.data.kind === 'text'
					? {
							kind: 'text',
							editor: createTextFileEditor(
								folder.files,
								read.data.file,
								autosave,
								() => void refresh(),
							),
						}
					: read.data,
		);
	}

	function forget(path: string) {
		recordingEditors.get(path)?.dispose();
		recordingEditors.delete(path);
		transformationEditors.get(path)?.dispose();
		transformationEditors.delete(path);
		if (selectedTransformationPath === path)
			selectedTransformationPath = undefined;
		const file = openFiles.get(path);
		if (file?.kind === 'text') file.editor.dispose();
		openFiles.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/** Settle input, then read the saved recording row an operation acts on. */
	async function recordingForOperation(
		path: string,
	): Promise<Result<RecordingEntry, string>> {
		const editor = recordingEditors.get(path);
		if (editor !== undefined && !(await editor.settle())) return Err(UNSETTLED);
		const stem = rowStemOf(RECORDINGS, path);
		if (stem === undefined) return Err(`${path} is not a recording.`);
		const read = await table.get(stem);
		if (read.error) return Err(read.error.message);
		if (read.data === undefined)
			return Err('This recording is no longer in the folder.');
		if (editor !== undefined && !(read.data.sha256 === editor.baseline.sha256))
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(read.data);
	}

	async function renameFile(
		from: string,
		to: string,
	): Promise<string | undefined> {
		const editor = textEditorAt(from);
		let expected: string;
		if (editor !== undefined) {
			if (!(await editor.settle())) return UNSETTLED;
			expected = editor.baseline.sha256;
		} else {
			const read = await folder.files.read(from);
			if (read.error) return read.error.message;
			expected = read.data.sha256;
		}
		const moved = await folder.files.move({ path: from, sha256: expected }, to);
		if (moved.error) {
			await refreshAll();
			return describeWriteError(moved.error);
		}
		const wasSelected = selectedPath === from;
		forget(from);
		await refreshAll();
		if (wasSelected) await open(to);
		return undefined;
	}

	/** Everything held only in this window, in the words the leave prompt shows. */
	function unsavedWork(): string[] {
		const held: string[] = [];
		if (recorder.phase !== 'idle') held.push('A recording is in progress.');
		// A confirmed publication is saved even when its current row cannot be read.
		const unresolved = pending.filter(
			(item) => item.state.kind !== 'published',
		).length;
		if (unresolved > 0)
			held.push(
				unresolved === 1
					? '1 recording is not saved to the folder. Its audio is kept in this window. Any files already written stay in the folder.'
					: `${unresolved} recordings are not saved to the folder. Their audio is kept in this window. Any files already written stay in the folder.`,
			);
		const transcripts = [...runs.values()];
		const unsavedTranscripts = transcripts.filter(
			(run) => run.kind === 'unsaved',
		).length;
		if (unsavedTranscripts > 0)
			held.push(
				unsavedTranscripts === 1
					? '1 transcript arrived but its file is not saved.'
					: `${unsavedTranscripts} transcripts arrived but their files are not saved.`,
			);
		if (transcripts.some((run) => run.kind === 'running'))
			held.push('A transcription is still running; its result would be lost.');
		const transforming = [...transformationRuns.values()];
		const unsavedOutputs = transforming.filter(
			(run) => run.state.kind === 'unsaved',
		).length;
		if (unsavedOutputs > 0)
			held.push(
				unsavedOutputs === 1
					? '1 transformation result arrived but its file is not saved.'
					: `${unsavedOutputs} transformation results arrived but their files are not saved.`,
			);
		if (transforming.some((run) => run.state.kind === 'running'))
			held.push('A transformation is still running; its result would be lost.');
		const unsettled = allEditors().filter(
			(editor) => editor.dirty || editor.saveState.kind !== 'saved',
		);
		for (const editor of unsettled)
			held.push(
				editor.saveState.kind === 'conflict'
					? `${editor.path} has edits held in a conflict.`
					: `${editor.path} has unsaved edits.`,
			);
		return held;
	}

	// --- recording ----------------------------------------------------------

	function setPending(id: string, next: PendingRecording | undefined) {
		pending =
			next === undefined
				? pending.filter((item) => item.capture.id !== id)
				: pending.some((item) => item.capture.id === id)
					? pending.map((item) => (item.capture.id === id ? next : item))
					: [next, ...pending];
	}

	/** The capture's recording is in the folder and was read as it is now: show it. */
	async function settle(id: string, entry: RecordingEntry) {
		setPending(id, undefined);
		await refreshAll();
		editorFor(entry);
	}

	/** One publication attempt for a pending capture. Its id and bytes never change. */
	async function publish(item: PendingRecording) {
		const attempt: PendingRecording = {
			...item,
			attempts: item.attempts + 1,
			state: { kind: 'saving' },
		};
		setPending(item.capture.id, attempt);
		const outcome = await publishRecording(
			folder,
			item.capture,
			workspace.injection?.aroundRecordingPublication,
		);
		if (outcome.status === 'saved') {
			await settle(item.capture.id, outcome.entry);
			selectedPath = outcome.entry.path;
			return;
		}
		setPending(item.capture.id, {
			...attempt,
			state:
				outcome.status === 'published'
					? {
							kind: 'published',
							publication: outcome.publication,
							problem: outcome.problem.status,
							message: outcome.problem.message,
							checking: false,
						}
					: outcome.status === 'partial'
						? {
								kind: 'partial',
								message: outcome.message,
								landed: outcome.landed,
							}
						: outcome.status === 'unexpected'
							? {
									kind: 'unexpected',
									message: outcome.message,
									path: outcome.path,
								}
							: { kind: 'failed', message: outcome.message },
		});
		// A partial or complete publication changed the folder; show what is there now.
		await refreshAll();
	}

	/**
	 * Look again at a recording whose publication is confirmed. This reads the
	 * row and nothing else: no batch, no file write, no request. A row that is
	 * this recording now, with whatever title or notes it has, ends the notice
	 * and becomes the entry that is shown. A row that is unreadable, gone, or
	 * someone else's is left exactly as it is and the notice says so.
	 */
	async function reconcile(item: PendingRecording) {
		if (item.state.kind !== 'published' || item.state.checking) return;
		const confirmed = item.state;
		const selectionBefore = selectedPath;
		setPending(item.capture.id, {
			...item,
			state: { ...confirmed, checking: true },
		});
		let observed: Awaited<ReturnType<typeof observePublication>>;
		try {
			observed = await observePublication(folder, item.capture);
		} catch (cause) {
			// A read that throws (the folder host went away) is an unreadable row.
			observed = { status: 'unreadable', message: describe(cause) };
		}
		// Dismissed while the read was running: its result must not restore
		// the notice or change the person's selection.
		if (!pending.some((held) => held.capture.id === item.capture.id)) return;
		if (observed.status === 'present') {
			await settle(item.capture.id, observed.entry);
			// Refresh may settle its notice, but it cannot undo a newer selection.
			if (selectedPath === selectionBefore) selectedPath = observed.entry.path;
			return;
		}
		setPending(item.capture.id, {
			...item,
			state: {
				...confirmed,
				problem: observed.status,
				message: observed.message,
				checking: false,
			},
		});
		await refreshAll();
	}

	function accept(audio: CapturedAudio, endedAt: Date) {
		const id = recordingId(endedAt);
		const item: PendingRecording = {
			// Fixed here, once: every attempt publishes this id, these bytes, and
			// these fields, and the row names the audio's path itself.
			capture: {
				id,
				bytes: audio.bytes,
				fields: {
					title: defaultTitle(endedAt),
					recordedAt: endedAt.toISOString(),
					durationMs: audio.durationMs,
					capture: audio.source,
					audioPath: recordingAudioPath(id, audio.extension),
				} as RecordingFields,
				body: '',
			},
			mimeType: audio.mimeType,
			attempts: 0,
			state: { kind: 'saving' },
		};
		setPending(item.capture.id, item);
		return item;
	}

	// --- transcription ------------------------------------------------------

	/**
	 * Transcript rows being written now, by result id, each naming its
	 * recording. A discard drops the text but cannot stop a write already
	 * begun, so the recording is not deleted under one.
	 */
	const writingResults = new Map<string, string>();

	/**
	 * Write a received transcript as `transcriptions/<transcript.id>.md`. The
	 * folder is read first: with no file there the row is created, never
	 * overwritten; this transcript's own row, left by an earlier write whose
	 * reply was lost, is recognized and not written twice; any other file there
	 * is left as it is.
	 *
	 * `admitted` is the run this save was let in under. Its outcome is applied
	 * only while that run still stands, so a save that ends after its
	 * transcript was discarded, or after a newer run began, restores nothing
	 * and removes nothing.
	 */
	async function saveResult(
		recording: string,
		transcript: ReceivedTranscript,
		admitted: TranscriptionRun,
	) {
		const { id, fields, text, body } = transcript;
		/** The row as the folder has it, or why it is not known to be there. */
		let published: Result<TranscriptionEntry, string>;
		writingResults.set(id, recording);
		// A read or write that throws (the folder host went away) must not lose the text.
		try {
			const existing = await results.get(id);
			if (existing.error) published = Err(existing.error.message);
			else if (existing.data === undefined) {
				const created = await results.create({ stem: id, fields, body });
				published = created.error
					? Err(describeWriteError(created.error))
					: Ok(created.data);
			} else
				published = isThisResult(existing.data, fields, body)
					? Ok(existing.data)
					: Err(
							`${existing.data.path} already exists and is not this transcript. Nothing was overwritten.`,
						);
		} catch (cause) {
			published = Err(describe(cause));
		} finally {
			writingResults.delete(id);
		}
		const stands = runs.get(recording) === admitted;
		if (published.error !== null) {
			if (stands)
				runs.set(recording, {
					kind: 'unsaved',
					id,
					fields,
					text,
					body,
					message: published.error,
					saving: false,
				});
			return;
		}
		// Saved, whatever the listing below reports. There is no await between
		// the write ending and this, so the recording is never without a run, a
		// write, or this row standing in the way of a deletion confirmed earlier.
		unlistedResults.set(published.data.path, published.data);
		if (stands) runs.delete(recording);
		await refreshAll();
	}

	// --- transformations ----------------------------------------------------

	/**
	 * Write a received result as `transformation_runs/<run.id>.md`. The row is
	 * created, never updated, so the transcript it came from is untouched. If an
	 * earlier attempt already wrote this exact result, it is recognized and not
	 * written twice; any other file at that path is left as it is.
	 */
	async function saveRun(run: TransformationRun, text: string) {
		const unsaved = (message: string) =>
			transformationRuns.set(run.id, {
				...run,
				state: { kind: 'unsaved', message, text },
			});
		const body = resultBody(text);
		try {
			const existing = await outputs.get(run.id);
			if (existing.error) {
				unsaved(existing.error.message);
				return;
			}
			if (existing.data === undefined) {
				const created = await outputs.create({
					stem: run.id,
					fields: run.fields,
					body,
				});
				if (created.error) {
					unsaved(describeWriteError(created.error));
					return;
				}
			} else if (!isThisResult(existing.data, run.fields, body)) {
				unsaved(
					`${existing.data.path} already exists and is not this result. Nothing was overwritten.`,
				);
				return;
			}
		} catch (cause) {
			unsaved(describe(cause));
			return;
		}
		transformationRuns.delete(run.id);
		await refreshAll();
	}

	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new Set<string>();
	const BEING_DELETED = 'This recording is being deleted.';

	/**
	 * Why a recording cannot be deleted now, or undefined. A request still
	 * running, or an answer that is not saved yet, would otherwise write a row
	 * that names a recording that is gone. So would the write of a transcript
	 * that was discarded while it was being saved. A failed run holds nothing
	 * and does not block; it is dropped with the recording.
	 */
	function recordingBusy(id: string): string | undefined {
		const transcript = runs.get(id);
		if (transcript?.kind === 'running')
			return 'A transcription of this recording is still running. Wait for it to finish, then delete the recording.';
		if (transcript?.kind === 'unsaved')
			return 'A transcript of this recording arrived but its file is not saved. Save it again or discard it in the notice under the header, then delete the recording.';
		if ([...writingResults.values()].includes(id))
			return 'A transcript of this recording is still being written to the folder. Wait for it to finish, then delete the recording.';
		const own = [...transformationRuns.values()].filter(
			(run) => run.fields.recordingId === id,
		);
		if (own.some((run) => run.state.kind === 'running'))
			return 'A transformation of this recording’s transcript is still running. Wait for it to finish, then delete the recording.';
		if (own.some((run) => run.state.kind === 'unsaved'))
			return 'A transformation result for this recording arrived but its file is not saved. Save it again or discard it in the notice under the header, then delete the recording.';
		return undefined;
	}

	/**
	 * What a transformation is made from, read from the folder now: the
	 * transcript's saved text and the recording it names. A list entry a caller
	 * holds may predate an edit or a deletion, so nothing is taken from one.
	 * Open edits to the transcript's file are saved first; edits that cannot be
	 * saved refuse, so what is sent is never text the folder does not have.
	 */
	async function transformationSource(
		transcriptionPath: string,
	): Promise<
		Result<
			{ transcriptionId: string; recordingId: string; input: string },
			string
		>
	> {
		const transcriptionId = rowStemOf(TRANSCRIPTIONS, transcriptionPath);
		if (transcriptionId === undefined)
			return Err(`${transcriptionPath} is not a transcript.`);
		const editor = textEditorAt(transcriptionPath);
		if (editor !== undefined && !(await editor.settle()))
			return Err(
				`${transcriptionPath} has edits that are not saved. Resolve them in its file, then run this again.`,
			);
		const read = await results.get(transcriptionId);
		if (read.error) return Err(read.error.message);
		const transcription = read.data;
		if (transcription === undefined)
			return Err('This transcript is no longer in the folder.');
		if (transcription.issues !== undefined)
			return Err(
				`${transcription.path} needs repair before it can be transformed. Fix it from Files.`,
			);
		if (transcription.body.trim() === '')
			return Err('This transcript has no text to transform.');
		const { recordingId } = transcription.fields;
		const recording = await table.get(recordingId);
		if (recording.error) return Err(recording.error.message);
		if (recording.data === undefined)
			return Err(
				'The recording this transcript was made from is no longer in the folder.',
			);
		if (deleting.has(recordingId)) return Err(BEING_DELETED);
		return Ok({ transcriptionId, recordingId, input: transcription.body });
	}

	/** One request for a run. It always ends: saved, unsaved with its text, or failed. */
	async function sendRun(run: TransformationRun) {
		transformationRuns.set(run.id, { ...run, state: { kind: 'running' } });
		const failed = (message: string) =>
			transformationRuns.set(run.id, {
				...run,
				state: { kind: 'failed', message },
			});
		let answered: Awaited<ReturnType<Workspace['transform']>>;
		try {
			answered = await workspace.transform({
				baseUrl: run.fields.endpoint,
				model: run.fields.model,
				prompt: run.fields.prompt,
				input: run.fields.input,
			});
		} catch (cause) {
			failed(
				`The transformation request could not be made: ${describe(cause)}`,
			);
			return;
		}
		if (answered.error) {
			failed(answered.error.message);
			return;
		}
		await saveRun(run, answered.data.text);
	}

	/** Settle input, then read the saved transformation an operation acts on. */
	async function transformationForOperation(
		path: string,
	): Promise<Result<TransformationEntry, string>> {
		const editor = transformationEditors.get(path);
		if (editor !== undefined && !(await editor.settle())) return Err(UNSETTLED);
		const stem = rowStemOf(TRANSFORMATIONS, path);
		if (stem === undefined) return Err(`${path} is not a transformation.`);
		const read = await profiles.get(stem);
		if (read.error) return Err(read.error.message);
		if (read.data === undefined)
			return Err('This transformation is no longer in the folder.');
		if (editor !== undefined && !(read.data.sha256 === editor.baseline.sha256))
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(read.data);
	}

	function byNewest<TEntry extends { fields: { createdAt?: unknown } }>(
		list: readonly TEntry[],
	): TEntry[] {
		return [...list].sort((a, b) =>
			String(b.fields.createdAt ?? '').localeCompare(
				String(a.fields.createdAt ?? ''),
			),
		);
	}

	return {
		workspace,
		folder,
		terminal,
		autosave,
		get entries() {
			return entries;
		},
		get transcriptions() {
			return transcriptions;
		},
		get unreadable() {
			return unreadable;
		},
		get listError() {
			return listError;
		},
		/** Every file and directory in the folder, as last listed. */
		get listing() {
			return listing;
		},
		get listingError() {
			return listingError;
		},
		expanded,
		get git() {
			return git;
		},
		get settings() {
			return settings;
		},
		/** Why `kv.json` could not be read, or what in it does not conform. */
		get settingsProblem() {
			return (
				settingsError ??
				kv?.issues?.map((issue) => issue.message).join('; ') ??
				undefined
			);
		},
		get credentialPresent() {
			return credentialPresent;
		},
		get selectedPath() {
			return selectedPath;
		},
		get selection() {
			return selection;
		},
		get pending() {
			return pending;
		},
		get recorder() {
			return recorder;
		},
		get recorderError() {
			return recorderError;
		},
		isRecording(path: string) {
			return rowPaths.has(path);
		},
		/** Results made from one recording, newest first. */
		resultsFor(id: string): TranscriptionEntry[] {
			return byNewest(
				transcriptions.filter((entry) => entry.fields.recordingId === id),
			);
		},
		transcriptionRun(id: string) {
			return runs.get(id);
		},
		/** Recordings waiting on a transcript whose file is not saved, by recording ID. */
		get unsavedTranscripts(): string[] {
			return [...runs]
				.filter(([, run]) => run.kind === 'unsaved')
				.map(([id]) => id);
		},

		/** Saved transformations, by title. Rows that need repair are included. */
		get transformations() {
			return transformations;
		},
		get transformationsError() {
			return transformationsError;
		},
		get unreadableTransformations() {
			return unreadableTransformations;
		},
		isTransformation(path: string) {
			return transformationPaths.has(path) || transformationEditors.has(path);
		},
		get selectedTransformationPath() {
			return selectedTransformationPath;
		},
		/** The transformation being edited, with its listed row when it is still in the folder. */
		get selectedTransformation() {
			const path = selectedTransformationPath;
			if (path === undefined) return undefined;
			const editor = transformationEditors.get(path);
			return (
				editor && {
					editor,
					entry: transformations.find((entry) => entry.path === path),
				}
			);
		},
		/** Every saved transformation result, newest first. */
		get transformationResults() {
			return byNewest(transformationResults);
		},
		/** Saved results made from one transcription, newest first. */
		outputsFor(transcriptionId: string): TransformationRunEntry[] {
			return byNewest(
				transformationResults.filter(
					(entry) => entry.fields.transcriptionId === transcriptionId,
				),
			);
		},
		/** Saved results one transformation produced, newest first. They outlive it. */
		outputsOf(transformationId: string): TransformationRunEntry[] {
			return byNewest(
				transformationResults.filter(
					(entry) => entry.fields.transformationId === transformationId,
				),
			);
		},
		/** Runs that are not saved results yet: running, failed, or received and unsaved. */
		get transformationRuns(): TransformationRun[] {
			return [...transformationRuns.values()];
		},
		get unsavedTransformations() {
			return [...transformationRuns.values()].filter(
				(run) => run.state.kind === 'unsaved',
			).length;
		},
		/** Rises once per completed folder refresh. */
		get generation() {
			return generation;
		},
		/** Transcripts that arrived but whose result file is not saved yet. */
		get unsavedResults() {
			return [...runs.values()].filter((run) => run.kind === 'unsaved').length;
		},
		/** Whether anything typed or received is not yet saved to a file. */
		get unsaved() {
			return (
				[...runs.values()].some((run) => run.kind === 'unsaved') ||
				[...transformationRuns.values()].some(
					(run) => run.state.kind === 'unsaved',
				) ||
				allEditors().some(
					(editor) => editor.dirty || editor.saveState.kind !== 'saved',
				)
			);
		},
		get saving() {
			return allEditors().some((editor) => editor.saveState.kind === 'saving');
		},
		get saveProblems() {
			return allEditors().filter(
				(editor) =>
					editor.saveState.kind === 'failed' ||
					editor.saveState.kind === 'conflict',
			).length;
		},
		/** Whether leaving now would lose typing, captured audio, or a live recording. */
		get holdsUnsavedWork() {
			return unsavedWork().length > 0;
		},
		/** What leaving now would lose, one plain line each. Empty when nothing would be. */
		get unsavedWork() {
			return unsavedWork();
		},
		/**
		 * Get ready to leave: save typing that can be saved, then report whether
		 * anything is still held only in this window. Nothing is discarded here.
		 */
		async prepareToLeave(): Promise<boolean> {
			for (;;) {
				const accepted = fileChanges;
				await accepted;
				if (!autosave.paused)
					await Promise.all(allEditors().map((editor) => editor.settle()));
				if (accepted === fileChanges) return unsavedWork().length === 0;
			}
		},
		refresh,
		refreshAll,
		open,
		/** First read after opening: settings exist in `kv.json` from the first launch on. */
		async start() {
			await refreshAll();
			if (kv !== undefined && kv.sha256 === undefined && !kv.issues) {
				const written = await folder.kv.update(kv, workspace.initialSettings);
				if (written.error === null) kv = written.data;
				else settingsError = describeWriteError(written.error);
			}
			credentialPresent = await workspace.credential
				.present()
				.catch(() => false);
			await refreshAll();
		},
		/** Explicitly discard a retained conflict whose saved file is gone. */
		discardRemoved(path: string) {
			const editor =
				recordingEditors.get(path) ??
				transformationEditors.get(path) ??
				textEditorAt(path);
			if (
				editor?.saveState.kind === 'conflict' &&
				editor.saveState.current === undefined
			)
				forget(path);
		},

		async startRecording() {
			if (recorder.phase !== 'idle') return;
			recorderError = undefined;
			recorder = { phase: 'starting' };
			const started = await workspace.capture.start();
			if (started.error) {
				recorder = { phase: 'idle' };
				recorderError = started.error.message;
				return;
			}
			active = started.data;
			recorder = { phase: 'recording', startedAt: started.data.startedAt };
		},
		/** Stop, keep the audio in this window, and publish it to the folder. */
		async stopRecording() {
			if (recorder.phase !== 'recording' || active === undefined) return;
			const capture = active;
			active = undefined;
			recorder = { phase: 'stopping' };
			const stopped = await capture.stop();
			recorder = { phase: 'idle' };
			if (stopped.error) {
				recorderError = stopped.error.message;
				return;
			}
			await publish(accept(stopped.data, new Date()));
		},
		cancelRecording() {
			active?.cancel();
			active = undefined;
			recorder = { phase: 'idle' };
		},
		/**
		 * Act on a held capture again. One whose publication is not confirmed is
		 * published again, under the same id and with the same bytes. One whose
		 * publication is confirmed is only read again: it is never republished.
		 */
		async retryPending(id: string) {
			const item = pending.find((candidate) => candidate.capture.id === id);
			if (item === undefined || item.state.kind === 'saving') return;
			if (item.state.kind === 'published') await reconcile(item);
			else await publish(item);
		},
		/**
		 * Drop a held capture. Files already in the folder are left as they are.
		 * For a published capture this drops only the notice and the copy held
		 * here: the recording's files are in the folder.
		 */
		discardPending(id: string) {
			setPending(id, undefined);
		},
		/** The recording whose row names `path` as its audio, if one does. */
		recordingNaming(path: string): RecordingEntry | undefined {
			return entries.find((entry) => audioPathIn(entry.fields) === path);
		},

		async transcribe(entry: RecordingEntry) {
			const id = entry.stem;
			// A transcript names its recording by this ID, so a filename that needs
			// repair is not sent anywhere.
			if (entry.issues?.some((issue) => issue.kind === 'filename')) return;
			// A received transcript is held until it is saved or discarded: a new
			// request never replaces it.
			const current = runs.get(id)?.kind;
			if (current === 'running' || current === 'unsaved') return;
			// Its transcript would name a recording that is on its way out.
			if (deleting.has(id)) return;
			// Only the path the row names is sent. No file is guessed from its stem.
			const audioPath = audioPathIn(entry.fields);
			if (audioPath === undefined) {
				runs.set(id, {
					kind: 'failed',
					message:
						'This recording’s file names no audio (it has no audioPath), so there is nothing to transcribe. Add the audio file’s path in Source.',
				});
				return;
			}
			const used = settings;
			const running: TranscriptionRun = { kind: 'running' };
			runs.set(id, running);
			// A run always ends: a transport that throws is a failure to retry,
			// never a request left running.
			let answered: Awaited<ReturnType<Workspace['transcribe']>>;
			try {
				answered = await workspace.transcribe({
					audioPath,
					baseUrl: used.transcriptionBaseUrl,
					model: used.transcriptionModel,
				});
			} catch (cause) {
				runs.set(id, {
					kind: 'failed',
					message: `The transcription request could not be made: ${cause instanceof Error ? cause.message : String(cause)}`,
				});
				return;
			}
			if (answered.error) {
				runs.set(id, { kind: 'failed', message: answered.error.message });
				return;
			}
			// Fixed here, once: every save of this answer writes this stem, these
			// fields, and this body.
			const at = new Date();
			await saveResult(
				id,
				{
					id: recordingId(at),
					fields: {
						recordingId: id,
						createdAt: at.toISOString(),
						model: used.transcriptionModel,
						endpoint: used.transcriptionBaseUrl,
					} as TranscriptionFields,
					text: answered.data.text,
					body: resultBody(answered.data.text),
				},
				running,
			);
		},
		/**
		 * Save a received transcript whose row is not known to be in the folder.
		 * The endpoint is not called and the file keeps the name it was given.
		 * While one save of it is under way, another does not start.
		 */
		async retrySaveResult(id: string) {
			const run = runs.get(id);
			if (run?.kind !== 'unsaved' || run.saving) return;
			const admitted: TranscriptionRun = { ...run, saving: true };
			runs.set(id, admitted);
			await saveResult(id, run, admitted);
		},
		/**
		 * Drop a run that is not running. A received transcript that was not
		 * saved is lost from this window; a write of it already begun may still
		 * reach the folder, and whatever it wrote stays there.
		 */
		dismissRun(id: string) {
			if (runs.get(id)?.kind !== 'running') runs.delete(id);
		},
		deleteResult: submitFileChange(
			async (entry: TranscriptionEntry): Promise<string | undefined> => {
				const removed = await results.delete(entry);
				if (removed.error === null) unlistedResults.delete(entry.path);
				await refreshAll();
				return removed.error ? describeWriteError(removed.error) : undefined;
			},
		),

		/**
		 * A new transformation file. The endpoint and model are copied from a
		 * transformation already in the folder. With none, the endpoint is the
		 * transcription endpoint and the model is left empty, since only the
		 * person knows which chat model that endpoint serves.
		 */
		createTransformation: submitFileChange(
			async ({
				title,
				prompt,
			}: {
				title: string;
				prompt: string;
			}): Promise<string | undefined> => {
				const like = transformations.find(
					(entry) => entry.issues === undefined,
				);
				const created = await profiles.create({
					fields: {
						title,
						model: like?.fields.model ?? '',
						endpoint: like?.fields.endpoint ?? settings.transcriptionBaseUrl,
					},
					body: prompt,
				});
				if (created.error) return describeWriteError(created.error);
				await refreshAll();
				transformationEditorFor(created.data);
				selectedTransformationPath = created.data.path;
				return undefined;
			},
		),
		/**
		 * Apply a saved transformation to a saved transcript, both named by path.
		 * What is sent is each file as the folder has it now, read here: the
		 * transformation's prompt and the transcript's text. The answer becomes a
		 * new row; the transcript row is never written. A reason is returned when
		 * nothing was sent.
		 */
		async transform(
			transcriptionPath: string,
			transformationPath: string,
		): Promise<string | undefined> {
			const read = await transformationForOperation(transformationPath);
			if (read.error !== null) return read.error;
			const profile = read.data;
			if (profile.issues !== undefined)
				return 'This transformation needs repair before it can run. Fix it in Source.';
			if (profile.fields.endpoint.trim() === '')
				return 'This transformation has no endpoint. Add one, then run it.';
			if (profile.fields.model.trim() === '')
				return 'This transformation has no model. Add one, then run it.';
			if (profile.body.trim() === '')
				return 'This transformation has no prompt. Write one, then run it.';
			const source = await transformationSource(transcriptionPath);
			if (source.error !== null) return source.error;
			// From this check to the run being listed there is no await, so a
			// deletion either sees this run or is seen here.
			if (deleting.has(source.data.recordingId)) return BEING_DELETED;
			const at = new Date();
			await sendRun({
				id: recordingId(at),
				fields: {
					recordingId: source.data.recordingId,
					transcriptionId: source.data.transcriptionId,
					transformationId: profile.stem,
					transformationTitle: profile.fields.title,
					createdAt: at.toISOString(),
					model: profile.fields.model.trim(),
					endpoint: profile.fields.endpoint.trim(),
					prompt: profile.body,
					input: source.data.input,
				} as TransformationRunFields,
				state: { kind: 'running' },
			});
			return undefined;
		},
		/**
		 * Finish a run that did not end as a saved result. A failed request is
		 * sent again as it was, but only while the folder still has what it was
		 * made from: the same transcript text, for a recording that is still
		 * there. Otherwise it stays failed and says why. A received result is
		 * only saved again: the endpoint is not called, and the file keeps the
		 * name it was given.
		 */
		async retryTransformation(id: string) {
			const run = transformationRuns.get(id);
			if (run === undefined) return;
			if (run.state.kind === 'unsaved') {
				await saveRun(run, run.state.text);
				return;
			}
			if (run.state.kind !== 'failed') return;
			const refuse = (message: string) =>
				transformationRuns.set(id, {
					...run,
					state: { kind: 'failed', message },
				});
			const source = await transformationSource(
				rowPath(TRANSCRIPTIONS, run.fields.transcriptionId),
			);
			if (source.error !== null) {
				refuse(`${source.error} Dismiss this run.`);
				return;
			}
			if (
				source.data.input !== run.fields.input ||
				source.data.recordingId !== run.fields.recordingId
			) {
				refuse(
					'The transcript changed after this run started, so the same request was not sent again. Dismiss this run and run the transformation again.',
				);
				return;
			}
			await sendRun(run);
		},
		/** Drop a run that is not running. A received result that was not saved is lost. */
		discardTransformationRun(id: string) {
			if (transformationRuns.get(id)?.state.kind !== 'running')
				transformationRuns.delete(id);
		},
		deleteTransformationResult: submitFileChange(
			async (entry: TransformationRunEntry): Promise<string | undefined> => {
				const removed = await outputs.delete(entry);
				await refreshAll();
				return removed.error ? describeWriteError(removed.error) : undefined;
			},
		),

		/** Save folder settings to `kv.json`; a file changed elsewhere is reread once. */
		saveSettings: submitFileChange(
			async (
				values: Partial<TranscriptionSettings>,
			): Promise<string | undefined> => {
				for (let attempt = 0; attempt < 2; attempt++) {
					const read = await folder.kv.get();
					if (read.error) return read.error.message;
					const written = await folder.kv.update(read.data, values);
					if (written.error === null) {
						kv = written.data;
						settingsError = undefined;
						await refreshAll();
						return undefined;
					}
					if (written.error.name !== 'Conflict')
						return describeWriteError(written.error);
				}
				return 'kv.json keeps changing while it is being saved. Try again.';
			},
		),
		async saveCredential(key: string): Promise<string | undefined> {
			const problem = await workspace.credential.set(key);
			if (problem === undefined) credentialPresent = key !== '';
			return problem;
		},

		/**
		 * Rename a file within its folder. Recording files keep their names; any
		 * other file moves as exact bytes, checked against the sha256 its editor
		 * saw or the sha256 read now.
		 */
		rename: submitFileChange(
			async (path: string, name: string): Promise<string | undefined> => {
				const directory = dirname(path);
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const to = joinPath(directory, name);
				if (to === path) return undefined;
				if (rowPaths.has(path) || recordingEditors.has(path))
					return RECORDING_NAME;
				if (transformationPaths.has(path) || transformationEditors.has(path))
					return TRANSFORMATION_NAME;
				// Nothing repairs a row's `audioPath` when the file it names moves.
				if (entries.some((entry) => audioPathIn(entry.fields) === path))
					return RECORDING_AUDIO_NAME;
				return renameFile(path, to);
			},
		),
		/** A new empty text file; it never replaces an existing one. */
		createFile: submitFileChange(
			async (directory: string, name: string): Promise<string | undefined> => {
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				if (listing?.directories.includes(path))
					return `"${name}" already exists here.`;
				const written = await folder.files.create(path, '');
				if (written.error) return describeWriteError(written.error);
				await refreshAll();
				await open(path);
				return undefined;
			},
		),
		createFolder: submitFileChange(
			async (directory: string, name: string): Promise<string | undefined> => {
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				if (
					listing?.directories.includes(path) ||
					listing?.files.some((file) => file.path === path)
				)
					return `"${name}" already exists here.`;
				const made = await folder.files.mkdir(path);
				if (made.error) return describeWriteError(made.error);
				if (directory !== '') expanded.add(directory);
				await refresh();
				return undefined;
			},
		),
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * Pending typing is saved first; a draft that cannot save refuses, so no
		 * deletion discards input. Only empty folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			if (listing?.directories.includes(path)) {
				const prefix = `${path}/`;
				const occupied =
					listing.files.some((file) => file.path.startsWith(prefix)) ||
					listing.directories.some((directory) => directory.startsWith(prefix));
				if (occupied)
					return Err(
						'Only empty folders can be deleted here. Delete or move what is inside first.',
					);
				return Ok({ kind: 'folder', path });
			}
			if (recordingEditors.has(path) || rowPaths.has(path)) {
				const entry = await recordingForOperation(path);
				if (entry.error !== null) return entry;
				const id = entry.data.stem;
				const busy = recordingBusy(id);
				if (busy !== undefined) return Err(busy);
				// A transcript saved since the last listing is named from its
				// publication; once listed, the listed row is the one named.
				const listed = new Set(transcriptions.map((result) => result.path));
				return Ok({
					kind: 'recording',
					entry: entry.data,
					results: [
						...transcriptions,
						...[...unlistedResults.values()].filter(
							(result) => !listed.has(result.path),
						),
					].filter((result) => result.fields.recordingId === id),
					outputs: transformationResults.filter(
						(result) => result.fields.recordingId === id,
					),
				});
			}
			if (transformationEditors.has(path) || transformationPaths.has(path)) {
				const entry = await transformationForOperation(path);
				if (entry.error !== null) return entry;
				const id = entry.data.stem;
				return Ok({
					kind: 'transformation',
					entry: entry.data,
					results: transformationResults.filter(
						(result) => result.fields.transformationId === id,
					).length,
				});
			}
			const text = textEditorAt(path);
			if (text !== undefined) {
				if (!(await text.settle())) return Err(UNSETTLED);
				return Ok({ kind: 'file', path, sha256: text.baseline.sha256 });
			}
			const read = await folder.files.read(path);
			if (read.error) return Err(read.error.message);
			return Ok({ kind: 'file', path, sha256: read.data.sha256 });
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		remove: submitFileChange(
			async (deletion: Deletion): Promise<string | undefined> => {
				if (deletion.kind === 'folder') {
					const removed = await folder.files.rmdir(deletion.path);
					await refresh();
					return removed.error ? describeWriteError(removed.error) : undefined;
				}
				const path =
					deletion.kind === 'file' ? deletion.path : deletion.entry.path;
				// The confirmation is modal, but a save may have started or failed since the capture.
				const editor =
					recordingEditors.get(path) ??
					transformationEditors.get(path) ??
					textEditorAt(path);
				if (editor && (editor.dirty || editor.saveState.kind !== 'saved'))
					return UNSETTLED;
				if (deletion.kind !== 'recording') {
					// A transformation's saved results are separate files and stay.
					const removed =
						deletion.kind === 'transformation'
							? await profiles.delete(deletion.entry)
							: await folder.files.remove({ path, sha256: deletion.sha256 });
					if (removed.error) {
						await refreshAll();
						return describeWriteError(removed.error);
					}
					forget(path);
					await refreshAll();
					return undefined;
				}

				// Work may have started or finished since the person was asked. A
				// request that is running, or an answer not saved yet, would write a
				// row naming this recording after it is gone; a result saved since is
				// one the person did not agree to delete.
				const id = deletion.entry.stem;
				if (deleting.has(id)) return BEING_DELETED;
				const busy = recordingBusy(id);
				if (busy !== undefined) return busy;
				const confirmed = new Set(
					[...deletion.results, ...deletion.outputs].map((row) => row.path),
				);
				// A transcript saved since the last listing counts from its publication.
				const unconfirmed = [
					...transcriptions,
					...unlistedResults.values(),
					...transformationResults,
				].some(
					(row) => row.fields.recordingId === id && !confirmed.has(row.path),
				);
				if (unconfirmed)
					return 'A new result was saved for this recording after you were asked. Check it, then delete the recording again.';
				// From here until the rows are gone, nothing new starts for it: there
				// is no await between the checks above and this.
				deleting.add(id);
				try {
					// The table removes the row file and nothing else. The audio the row
					// names is an ordinary file; it stays, and Files can delete it.
					const removed = await table.delete(deletion.entry);
					if (removed.error) {
						await refreshAll();
						return describeWriteError(removed.error);
					}
					forget(path);
					// What failed for this recording held nothing, and has nothing left to retry against.
					if (runs.get(id)?.kind === 'failed') runs.delete(id);
					for (const run of [...transformationRuns.values()])
						if (run.fields.recordingId === id && run.state.kind === 'failed')
							transformationRuns.delete(run.id);
					const leftovers: string[] = [];
					for (const result of deletion.results) {
						const gone = await results.delete(result);
						if (gone.error) leftovers.push(result.path);
						else unlistedResults.delete(result.path);
					}
					for (const output of deletion.outputs) {
						const gone = await outputs.delete(output);
						if (gone.error) leftovers.push(output.path);
					}
					await refreshAll();
					return leftovers.length > 0
						? `The recording was deleted, but these results could not be: ${leftovers.join(', ')}`
						: undefined;
				} finally {
					deleting.delete(id);
				}
			},
		),
		/** Commit current saved files. Unsaved editor input is not included. */
		commit(): Promise<CommitOutcome> {
			return folder.git.commit();
		},
		/**
		 * Save what can still be saved, then release the folder. A draft that
		 * cannot save and audio that could not be published end with the page;
		 * the view asks before the page is left while either exists.
		 */
		async close() {
			closing = true;
			await fileChanges;
			active?.cancel();
			for (const editor of allEditors()) {
				await editor.settle();
				editor.dispose();
			}
			unwatch();
			unsubscribe();
			await workspace.close();
		},
	};
}
