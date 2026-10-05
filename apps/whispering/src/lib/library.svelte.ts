/**
 * The Whispering product state over one opened workspace.
 *
 * Everything shown is an observation of the folder's current files: the
 * recording rows, their transcription results, the transformations and their
 * results, the settings in `kv.json`, and the listing the file browser shows.
 * They refresh together after saves, terminal commands, window focus, and any
 * change another program makes. A selection is a path; one draft is retained
 * per path so a selection change never discards typing. A recording,
 * transcript, or transformation is edited through the folder's row editor
 * (`table.edit`), which owns its input and saves it as it is typed; one
 * editor serves both its fields and its source (`row-editing.svelte.ts`).
 * A refresh never reloads an open row: a change made elsewhere shows when
 * the person reloads it, and otherwise the next save writes over it. Any
 * other file is edited as text.
 *
 * Three things live only in this window until they reach the folder: unsaved
 * typing, a captured recording whose audio and row are not both in place, and
 * text an endpoint returned whose file is not written yet. All are kept
 * across failures and all block leaving the app.
 *
 * Git status comes from the folder's shared snapshot; this module adds no
 * status cache of its own. A save and its commit are separate outcomes.
 */
import type {
	CommitOutcome,
	FileError,
	FileListing,
	FileTable,
	GitSnapshot,
	KvSnapshot,
	KvWriteError,
	TableEditError,
	TableListing,
	TableSnapshot,
	TableWriteError,
} from '@epicenter/folder';
import { hashBytes, inspectRow, rowPath, rowStemOf } from '@epicenter/folder';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
} from '@epicenter/folder/file-browser';
import { customAlphabet } from 'nanoid';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import type { ActiveCapture, CapturedAudio } from './capture.js';
import {
	type ConnectionChange,
	type ConnectionsInfo,
	type LegacyKeyTargets,
	type Operation,
	sameBaseUrl,
} from './connections.js';
import {
	audioPathIn,
	type LegacySettings,
	RECORDINGS,
	type RecordingFields,
	recordingAudioPath,
	type TextRunFields,
	TRANSCRIPTIONS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TransformationFields,
	type TransformationRunFields,
	whisperingDefinition,
} from './definition.js';
import {
	type Autosave,
	conflictCopyPath,
	createTextFileEditor,
	type SavedText,
	type TextFileEditor,
} from './editor.svelte.js';
import { nameProblem, readTextFile } from './files.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import {
	type RecipeReading,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import {
	type InPlace,
	isThisRecording,
	type PendingCapture,
	type PublishOutcome,
	publishRecording,
} from './recordings/publish.js';
import { createRowEditing, type RowEditing } from './row-editing.svelte.js';
import { createTerminalSession } from './terminal.svelte.js';
import type { Workspace } from './workspace/index.js';

export type Library = ReturnType<typeof createLibrary>;
export type RecordingEntry = TableSnapshot<RecordingFields>;
export type TranscriptionEntry = TableSnapshot<TranscriptionFields>;
export type TransformationEntry = TableSnapshot<TransformationFields>;
export type TransformationRunEntry = TableSnapshot<TransformationRunFields>;
export type TextRunEntry = TableSnapshot<TextRunFields>;

/**
 * A file the person opened that is not edited as a row: an ordinary file,
 * or a row file the folder opened no editor for.
 */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: TextFileEditor }
	| { readonly kind: 'audio'; readonly size: number }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

/**
 * The one row editor kept for a recording, transcript, or transformation
 * file, serving the fields and the source alike, so every view of the file
 * edits the same input. Readable text opens whether or not it is a valid
 * row. `unopened` is a file that could not be read when it was opened: it
 * stays shown, with why, until the person tries again.
 */
export type RowSlot<TFields> =
	| { readonly kind: 'opening'; readonly done: Promise<void> }
	| { readonly kind: 'open'; readonly editing: RowEditing<TFields> }
	| { readonly kind: 'unopened'; readonly message: string };

export type Selection =
	| {
			readonly kind: 'recording';
			readonly path: string;
			readonly slot: RowSlot<RecordingFields>;
			/** The listed row, or undefined when the file left the folder. */
			readonly entry: RecordingEntry | undefined;
	  }
	| {
			readonly kind: 'transcript';
			readonly path: string;
			readonly slot: RowSlot<TranscriptionFields>;
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
	/**
	 * A recording or transformation file that is there and cannot be read as
	 * a row: only that file is removed, conditional on the exact bytes read.
	 * Results that name it are kept. `recordingId` is the recording its name
	 * makes it, so no work for that recording runs beside its removal.
	 */
	| {
			readonly kind: 'unreadableRow';
			readonly table: typeof RECORDINGS | typeof TRANSFORMATIONS;
			readonly path: string;
			readonly sha256: string;
			readonly recordingId: string | undefined;
			/** Why it could not be read as a row. */
			readonly problem: string;
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
		/** The last attempt stopped before the row was in place. */
		| Exclude<PublishOutcome, { kind: 'published' }>
		/**
		 * Both files are in place: written by this window's confirmed writes,
		 * or found by a retry. The row could not then be shown as this
		 * recording: the read failed, or another writer removed or changed it
		 * afterward. Nothing is unsaved. The only thing done from here is to
		 * read the row again; nothing is written again and nothing is recreated.
		 */
		| {
				readonly kind: 'published';
				readonly audio: InPlace;
				readonly row: InPlace;
				readonly problem: 'unreadable' | 'missing' | 'foreign';
				readonly message: string;
				/** Whether the row is being read again now. */
				readonly checking: boolean;
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

/** Where a run stands, until its result row is saved. */
export type RunState =
	| { readonly kind: 'running' }
	/** Nothing was received. Trying again sends the same request. */
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * The endpoint answered and the text is held here, not known to be in the
	 * folder. `message` says why a save did not finish; it is undefined for a
	 * result on pasted text that has not been asked to save yet.
	 */
	| {
			readonly kind: 'unsaved';
			readonly message: string | undefined;
			readonly text: string;
	  };

/**
 * One application of a recipe to a transcript, until its result row is
 * saved. `id` is the result row's stem and `fields` is exactly what the row
 * will hold, including the instructions, input, model, and endpoint sent;
 * both are fixed before the request is sent, so a retry of either the request
 * or the save lands in the same file and never makes a second result. A
 * received result is saved at once, into `transformation_runs/`.
 */
export type TransformationRun = {
	readonly id: string;
	readonly destination: 'transcript';
	readonly fields: TransformationRunFields;
	readonly state: RunState;
};

/**
 * One application of a recipe to pasted text. The same lifecycle as a
 * transcript's run, except that a received result is held in this window
 * until the person saves it, into `text_runs/`, or discards it.
 */
export type TextRun = {
	readonly id: string;
	readonly destination: 'text';
	readonly fields: TextRunFields;
	readonly state: RunState;
};

type Run = TransformationRun | TextRun;

/** The same run in another state; a run's destination and snapshot never change. */
const withState = <TRun extends Run>(run: TRun, state: RunState): TRun => ({
	...run,
	state,
});

const UNSETTLED = 'Save or discard the open edits first.';
const LEAVING = 'Whispering is closing, so nothing new was started.';
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
function describeWriteError(
	error: TableWriteError | KvWriteError | FileError,
): string {
	if (error.name === 'Exists')
		return `"${basename(error.path)}" already exists here.`;
	if (error.name === 'Conflict')
		return error.actualSha256 === undefined
			? 'The file is no longer here. Nothing was changed. Check it and try again.'
			: 'The file has different content now. Nothing was changed. Check it and try again.';
	if (error.name === 'DirectoryNotEmpty')
		return 'The folder is not empty, so nothing was deleted.';
	// A move whose second step failed: the file is at both paths now.
	if (error.name === 'SourceNotRemoved')
		return `"${basename(error.to)}" was written, but "${basename(error.from)}" could not be removed, so both are in the folder now: ${error.cause.message}`;
	return error.message;
}

/** A received answer as its row's body: the text, ending in one newline of its own. */
const resultBody = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** A listing's files that were read, and the ones that were not, with why. */
function splitListing<TFields>(listing: TableListing<TFields>) {
	const entries: TableSnapshot<TFields>[] = [];
	const failed: { path: string; message: string }[] = [];
	for (const { path, result } of listing) {
		const { data: entry, error: readError } = result;
		if (readError === null) entries.push(entry);
		else failed.push({ path, message: readError.message });
	}
	return { entries, failed };
}

/**
 * Whether a row already at a result's path is that result's own: a row that
 * parses, with the same body and every field that was fixed for it, each
 * validated. A row that differs in any of them (another prompt, model,
 * endpoint, transcript, or source) is someone else's file, and so is one
 * whose text does not parse. Fields the app does not declare are not part of
 * what was fixed, so extra ones do not make it a different result.
 */
function isThisResult(
	existing: TableSnapshot<Record<string, unknown>>,
	fields: object,
	body: string,
): boolean {
	if (existing.body !== body) return false;
	const saved = existing.fields;
	return Object.entries(fields).every(([key, value]) => saved[key] === value);
}

/** What one path holds, against the file as it was before a move. */
export type PathState = 'matches' | 'different' | 'missing' | 'unreadable';

/**
 * A rename whose reply was lost, or that left the file at both paths, while
 * the text draft at `from` was open. The draft holds its edits until the
 * person chooses where they go. A row's editor holds no edits of its own
 * after settling, so a row is put down instead.
 */
export type UnresolvedMove = {
	readonly from: string;
	readonly to: string;
	/** The SHA-256 of the file as it was when the rename was asked for. */
	readonly expected: string;
	/** What the folder said, in the words the person is shown. */
	readonly message: string;
	/** What each path held when last read. It says nothing about what the move did. */
	readonly found: { readonly from: PathState; readonly to: PathState };
};

/**
 * How the person ends an unresolved rename: keep the edits at a path that
 * holds the file as it was, open a path as it is without them, or discard
 * them.
 */
export type MoveChoice =
	| 'keepAtSource'
	| 'keepAtDestination'
	| 'openSource'
	| 'openDestination'
	| 'discard';

/** A table whose rows the window edits, and the one slot kept for each row path. */
type RowTable<TFields> = {
	readonly table: FileTable<TFields>;
	readonly rows: SvelteMap<string, RowSlot<TFields>>;
};

/**
 * What a refused `table.edit` leaves. Readable text always opens, valid or
 * not, so a refusal means there is no text to edit: the row is gone, or the
 * file cannot be read as text, or opening was cancelled. None keeps a draft.
 */
function rowRefusal(
	error: TableEditError,
):
	| { readonly kind: 'missing' }
	| { readonly kind: 'unopened'; readonly message: string } {
	if (error.name === 'NotFound') return { kind: 'missing' };
	return { kind: 'unopened', message: error.message };
}

/** The SHA-256 of text as a file holds it. */
const textSha256 = (text: string) => hashBytes(new TextEncoder().encode(text));

export function createLibrary(workspace: Workspace) {
	const { folder } = workspace;
	let closing = false;
	/** Aborts row editors still opening when the library closes. */
	const lifetime = new AbortController();
	/**
	 * Whether new work starts: a capture, a request, a retry, a file change, or
	 * typing. Off while the page decides whether it may close, so what it saves
	 * and inspects is all there is. Work accepted before stays accepted and
	 * settles as it would have.
	 */
	let admitting = $state(true);
	/**
	 * Paths whose file is being moved or deleted. Their drafts write nothing
	 * until that has an outcome, so no late save recreates the file or moves
	 * it out from under the operation.
	 */
	const fenced = new Set<string>();
	/** Paths whose file is being deleted. Their drafts take no typing either. */
	const retiring = new Set<string>();
	/**
	 * Paths whose row is being settled and read for an operation that changes
	 * the path. Their editors take no input, so nothing typed after the
	 * operation began changes what it acts on; they still finish saving.
	 */
	const settling = new Set<string>();
	/**
	 * Paths a move or deletion owns, from its admission until it has an
	 * outcome. Only that operation sets or clears their fences, so two of
	 * them never release each other's (`owning`).
	 */
	const claimed = new Set<string>();
	/**
	 * Renames of ordinary files that did not end as asked, by the path whose
	 * text draft holds the edits. The draft takes typing and writes nothing,
	 * and holds the close, its source, and its path, until the person chooses
	 * where the edits go.
	 */
	const unresolvedMoves = new SvelteMap<string, UnresolvedMove>();
	/** A text draft takes typing while its file moves, and carries it to where it went. */
	const typingAt = (path: string) => () => admitting && !retiring.has(path);
	/**
	 * A row's editor saves what it takes at once, so it takes no input at all
	 * while its file is moved or deleted: the operation acts on what was
	 * settled before it.
	 */
	const rowInputAt = (path: string) => () =>
		admitting && !fenced.has(path) && !settling.has(path);
	const writesAt = (path: string) => () =>
		!fenced.has(path) && !unresolvedMoves.has(path);
	/** Each caller owns its result; this promise joins accepted file commands. */
	let fileChanges: Promise<unknown> = Promise.resolve();
	function submitFileChange<TArgs extends unknown[]>(
		work: (...args: TArgs) => Promise<string | undefined>,
	) {
		return (...args: TArgs): Promise<string | undefined> => {
			if (closing) return Promise.resolve('The library is closing.');
			if (!admitting) return Promise.resolve(LEAVING);
			const submitted = structuredClone(args);
			const running = work(...submitted);
			fileChanges = Promise.allSettled([fileChanges, running]);
			return running;
		};
	}

	const table = folder.tables.recordings;
	const results = folder.tables.transcriptions;
	const profiles = folder.tables.transformations;
	const outputs = folder.tables.transformation_runs;
	const textOutputs = folder.tables.text_runs;

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
	let textResults = $state.raw<TextRunEntry[]>([]);
	/** Why `text_runs/` could not be listed; the last list read stays shown. */
	let textResultsError = $state<string | undefined>();
	let unreadableTextResults = $state.raw<{ path: string; message: string }[]>(
		[],
	);
	/**
	 * Result files the last listing found and could not read as text, by table.
	 * A recording's results are found by the `recordingId` each row holds, and
	 * a file with no text says nothing about whose it is.
	 */
	const resultsUnknown = new Map<string, string>();
	function noteUnread(
		table: string,
		failed: readonly { path: string; message: string }[],
	) {
		if (failed.length === 0) resultsUnknown.delete(table);
		else
			resultsUnknown.set(
				table,
				`${failed.map((item) => item.path).join(', ')} could not be read as text`,
			);
	}
	let selectedTransformationPath = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	let git = $state.raw<GitSnapshot>(folder.git.snapshot);
	let kv = $state.raw<KvSnapshot<LegacySettings> | undefined>();
	let settingsError = $state<string | undefined>();
	/** What the device has set up, never a key; undefined until read or when the read failed. */
	let connections = $state.raw<ConnectionsInfo | undefined>();
	let connectionsError = $state<string | undefined>();
	let selectedPath = $state<string | undefined>();
	let pending = $state.raw<PendingRecording[]>([]);
	let recorder = $state.raw<RecorderState>({ phase: 'idle' });
	let recorderError = $state<string | undefined>();
	let active: ActiveCapture | undefined;
	/** The start that has not answered yet. Aborting it releases a microphone that opens late. */
	let starting: AbortController | undefined;
	/** How many folder reads are under way. */
	let reading = $state(0);
	let refreshSequence = 0;
	/**
	 * Transcripts whose publication was confirmed and that no applied listing
	 * has accounted for yet, by path. `transcriptions` is an observation and
	 * lags a save, or misses it when the read fails; a deletion counts these
	 * as the recording's results from the moment they are saved.
	 */
	const unlistedResults = new Map<string, TranscriptionEntry>();
	/** The same for transformation results, which a deletion also counts. */
	const unlistedOutputs = new Map<string, TransformationRunEntry>();
	/** Counts completed folder refreshes; audio players recheck their file on each. */
	let generation = $state(0);
	const autosave = $state<Autosave>({ paused: false });

	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([RECORDINGS]);
	/** The rows edited in this window, by path, each with its one retained editor. */
	const recordingRows: RowTable<RecordingFields> = {
		table,
		rows: new SvelteMap(),
	};
	const transcriptRows: RowTable<TranscriptionFields> = {
		table: results,
		rows: new SvelteMap(),
	};
	const transformationRows: RowTable<TransformationFields> = {
		table: profiles,
		rows: new SvelteMap(),
	};
	/** Any other file opened for reading or editing, by path. */
	const openFiles = new SvelteMap<string, OpenFile>();
	const runs = new SvelteMap<string, TranscriptionRun>();
	/** Recipe runs on transcripts and on pasted text, keyed by the result row's stem. */
	const recipeRuns = new SvelteMap<string, Run>();
	const transcriptRuns = (): TransformationRun[] =>
		[...recipeRuns.values()].filter(
			(run): run is TransformationRun => run.destination === 'transcript',
		);
	const textRuns = (): TextRun[] =>
		[...recipeRuns.values()].filter(
			(run): run is TextRun => run.destination === 'text',
		);

	const rowPaths = $derived(new Set(entries.map((entry) => entry.path)));
	const transformationPaths = $derived(
		new Set(transformations.map((entry) => entry.path)),
	);

	/** The one decision about a recipe, against the text connection as last read. */
	function resolve(recipe: RecipeReading): ResolvedRecipe {
		return resolveRecipe(recipe, connections?.text, connectionsError);
	}

	async function readConnections() {
		try {
			connections = await workspace.connections.read();
			connectionsError = undefined;
		} catch (cause) {
			connections = undefined;
			connectionsError = describe(cause);
		}
	}
	/**
	 * What is selected, read from the slots each time. Not a cached `$derived`:
	 * a row reopened in place is deleted and set again under the same path,
	 * and a derived read outside an effect kept the slot from before that.
	 */
	function selection(): Selection | undefined {
		const path = selectedPath;
		if (path === undefined) return undefined;
		const recording = recordingRows.rows.get(path);
		if (recording !== undefined)
			return {
				kind: 'recording',
				path,
				slot: recording,
				entry: entries.find((entry) => entry.path === path),
			};
		const transcript = transcriptRows.rows.get(path);
		if (transcript !== undefined)
			return { kind: 'transcript', path, slot: transcript };
		const file = openFiles.get(path);
		return file && { kind: 'file', path, file };
	}

	const terminal = createTerminalSession(
		{
			get cwd() {
				return workspace.terminal.cwd;
			},
			exec: (command, options) =>
				admitting
					? workspace.terminal.exec(command, options)
					: Promise.reject(new Error(LEAVING)),
		},
		refreshAll,
	);
	const input = createMicrophoneInput({
		capture: workspace.capture,
		preferences: workspace.preferences,
		recording: () => recorder.phase !== 'idle',
	});
	const unsubscribe = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	const unwatch = workspace.onExternalChange(() => void refreshAll());

	function textEditorAt(path: string): TextFileEditor | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'text' ? file.editor : undefined;
	}

	const rowTables = [
		recordingRows,
		transcriptRows,
		transformationRows,
	] as const;

	/** Run `act` on the row table a path is a row of, if it is one of the edited tables. */
	function withRowTable<R>(
		path: string,
		act: <TFields>(kind: RowTable<TFields>) => R,
	): R | undefined {
		if (rowStemOf(RECORDINGS, path) !== undefined) return act(recordingRows);
		if (rowStemOf(TRANSCRIPTIONS, path) !== undefined)
			return act(transcriptRows);
		if (rowStemOf(TRANSFORMATIONS, path) !== undefined)
			return act(transformationRows);
		return undefined;
	}

	/** The slot kept for a row path, of whichever edited table it belongs to. */
	const slotAt = (path: string): RowSlot<unknown> | undefined =>
		withRowTable(path, ({ rows }) => rows.get(path) as RowSlot<unknown>);

	/** Every row editor kept now. */
	function rowEditings(): RowEditing<unknown>[] {
		const editings: RowEditing<unknown>[] = [];
		for (const { rows } of rowTables)
			for (const slot of rows.values())
				if (slot.kind === 'open')
					editings.push(slot.editing as RowEditing<unknown>);
		return editings;
	}

	/** Every text draft kept now: one per open ordinary file. */
	function textEditors(): TextFileEditor[] {
		const editors: TextFileEditor[] = [];
		for (const file of openFiles.values())
			if (file.kind === 'text') editors.push(file.editor);
		return editors;
	}

	/** Whether a text draft holds typing or a save problem that leaving would lose. */
	const textHolds = (editor: TextFileEditor) =>
		editor.dirty || editor.saveState.kind !== 'saved';

	/** The text draft kept for an ordinary file's path. */
	const textDraftAt = textEditorAt;

	/** The row editor kept for a path, once it is open. */
	function rowEditingAt(path: string): RowEditing<unknown> | undefined {
		const slot = slotAt(path);
		return slot?.kind === 'open' ? slot.editing : undefined;
	}

	/**
	 * Settle the draft kept for a file. For an ordinary file, say which saved
	 * version it settled on; a row's editor exposes none, so a caller that
	 * needs one reads the file after this. Undefined when no version is known.
	 * A row whose save stopped, or a text draft whose input cannot be saved
	 * without the person, refuses.
	 */
	async function settleDraft(
		path: string,
	): Promise<Result<string | undefined, string>> {
		const moved = unresolvedMoves.get(path);
		if (moved !== undefined) return Err(unresolvedHold(moved));
		const slot = slotAt(path);
		if (slot?.kind === 'opening') {
			await slot.done;
			return settleDraft(path);
		}
		if (slot?.kind === 'open') {
			const { error: flushError } = await slot.editing.flush();
			return flushError === null ? Ok(undefined) : Err(UNSETTLED);
		}
		const editor = textDraftAt(path);
		if (editor === undefined) return Ok(undefined);
		if (!(await editor.settle())) return Err(UNSETTLED);
		return Ok(editor.baseline.sha256);
	}

	/** Why a draft whose rename did not end as asked is held, in the words the person is shown. */
	const unresolvedHold = (moved: UnresolvedMove) =>
		`The rename of "${basename(moved.from)}" to "${basename(moved.to)}" did not end as asked. Its edits are kept in this window and not saved until you choose where they go.`;

	/** Whether the draft kept for a file holds typing, a save in question, or an unresolved rename. */
	function draftHolds(path: string): boolean {
		if (unresolvedMoves.has(path)) return true;
		const slot = slotAt(path);
		if (slot?.kind === 'open') return slot.editing.holds;
		const editor = textDraftAt(path);
		return editor !== undefined && textHolds(editor);
	}

	/**
	 * Open the row at `path` into the one editor kept for it, and return it.
	 * Readable text opens, valid or not, and its fields and source are the
	 * same editor. A row that is gone, or a file that cannot be read as text,
	 * keeps no editor and says so; with `retain`, a file that cannot be read
	 * keeps an `unopened` slot that says why, for the person to try again.
	 * Trying a retained `unopened` slot again keeps that slot on another
	 * failure.
	 */
	async function openRow<TFields>(
		kind: RowTable<TFields>,
		path: string,
		options: { retain?: boolean } = {},
	): Promise<
		| RowSlot<TFields>
		| { readonly kind: 'missing' }
		| { readonly kind: 'unopened'; readonly message: string }
	> {
		const { table: rowTable, rows } = kind;
		const known = rows.get(path);
		if (known?.kind === 'opening') {
			await known.done;
			return rows.get(path) ?? { kind: 'missing' };
		}
		if (known !== undefined && known.kind !== 'unopened') return known;
		const retain = options.retain === true || known !== undefined;
		const stem = rowStemOf(rowTable.name, path);
		if (stem === undefined)
			return { kind: 'unopened', message: `${path} is not a row.` };
		if (closing) return { kind: 'unopened', message: LEAVING };
		const { promise: done, resolve: settled } = Promise.withResolvers<void>();
		const opening: RowSlot<TFields> = { kind: 'opening', done };
		rows.set(path, opening);
		try {
			const { data: editor, error: editError } = await rowTable.edit(stem, {
				signal: lifetime.signal,
			});
			// Forgotten, or the library closed, while it was opening: it belongs
			// to no view. An editor that was given no input holds nothing.
			if (rows.get(path) !== opening || closing) {
				if (rows.get(path) === opening) rows.delete(path);
				return rows.get(path) ?? { kind: 'missing' };
			}
			if (editError === null) {
				const slot: RowSlot<TFields> = {
					kind: 'open',
					editing: createRowEditing(editor, {
						path,
						admits: rowInputAt(path),
						onSaved: refreshAfterSave,
					}),
				};
				rows.set(path, slot);
				return slot;
			}
			const refused = rowRefusal(editError);
			if (refused.kind === 'unopened' && retain) {
				rows.set(path, refused);
				return refused;
			}
			rows.delete(path);
			return refused;
		} finally {
			settled();
		}
	}

	/** Open the row at `path` in whichever edited table it belongs to; undefined when it is not a row. */
	function openRowAt(
		path: string,
		options?: { retain?: boolean },
	):
		| Promise<
				| RowSlot<unknown>
				| { readonly kind: 'missing' }
				| { readonly kind: 'unopened'; readonly message: string }
		  >
		| undefined {
		const opened = withRowTable(
			path,
			(kind) => openRow(kind, path, options) as Promise<unknown>,
		);
		return opened as ReturnType<typeof openRow<unknown>> | undefined;
	}

	/** A text draft of an ordinary file, under the same admission and write fences as every draft. */
	function textEditorOf(file: SavedText): TextFileEditor {
		return createTextFileEditor(
			folder.files,
			file,
			autosave,
			() => void refresh(),
			typingAt(file.path),
			writesAt(file.path),
		);
	}

	/**
	 * Take an open row's file as it is now, as the person asked: what its
	 * editor holds, a stopped save included, is replaced by the file. Writes
	 * already admitted settle first, and the editor takes no input while the
	 * file is read. A read failure, a missing file included, keeps the row and its input
	 * and says why. Discarding a missing row is a separate explicit choice.
	 */
	async function reloadRow(path: string): Promise<string | undefined> {
		if (!admitting) return LEAVING;
		const editing = rowEditingAt(path);
		if (editing === undefined) return undefined;
		if (claimed.has(path) || settling.has(path))
			return `"${basename(path)}" is being moved or deleted. Try again when that has finished. Nothing was changed.`;
		const { error: reloadError } = await editing.reload();
		if (reloadError === null) return undefined;
		switch (reloadError.name) {
			case 'NotFound':
				return `"${basename(path)}" is no longer in the folder. Your edits are kept here.`;
			case 'InputChanged':
				return 'Something was typed while the file was being read, so it was kept and the file was not loaded.';
			default:
				return `"${basename(path)}" could not be read, so nothing was changed: ${reloadError.message}`;
		}
	}

	/** Newest first; a row whose time cannot be read sorts by its file name. */
	function sortEntries(list: readonly RecordingEntry[]) {
		const key = (entry: RecordingEntry) => entry.fields.recordedAt ?? '';
		return [...list].sort(
			(a, b) =>
				key(b).localeCompare(key(a)) ||
				(a.path < b.path ? 1 : a.path > b.path ? -1 : 0),
		);
	}

	/**
	 * Show newer saved text in the text drafts of ordinary files, and put down
	 * clean ones whose files left the folder.
	 */
	async function observeTextDrafts(current: FileListing, sequence: number) {
		const present = new Map(
			current.files.map((file) => [file.path, file.size]),
		);
		const drafts: {
			readonly path: string;
			readonly editor: TextFileEditor;
			readonly putDown: () => void;
		}[] = [];
		for (const [path, file] of openFiles) {
			if (file.kind === 'loading') continue;
			if (file.kind === 'text') {
				drafts.push({
					path,
					editor: file.editor,
					putDown: () => openFiles.delete(path),
				});
				continue;
			}
			const size = present.get(path);
			if (size === undefined) openFiles.delete(path);
			else if (file.kind !== 'failed' && size !== file.size)
				openFiles.set(path, { ...file, size });
		}
		for (const { path, editor, putDown } of drafts) {
			if (sequence !== refreshSequence) return;
			// A draft held by an unresolved rename stays as it is until the person chooses.
			if (unresolvedMoves.has(path)) continue;
			if (!present.has(path)) {
				if (textHolds(editor)) editor.observeRemoved();
				else {
					editor.dispose();
					putDown();
				}
				continue;
			}
			const { data: opened, error: readError } = await readTextFile(
				folder.files,
				path,
			);
			if (sequence !== refreshSequence) return;
			if (readError === null && opened.kind === 'text')
				editor.observe(opened.file);
		}
	}

	/**
	 * Put down the open rows of a table whose files its listing no longer
	 * found and whose editors hold nothing: every input they took is saved,
	 * and nothing creates the file again. An open row is never read again
	 * here; what another program wrote shows when the person reloads it.
	 */
	function putDownMissingRows<TFields>(
		kind: RowTable<TFields>,
		listed: TableListing<TFields>,
	) {
		const present = new Set(listed.map((item) => item.path));
		for (const [path, slot] of kind.rows)
			if (slot.kind === 'open' && !present.has(path) && !slot.editing.holds)
				forget(path);
	}

	/** By title; a row whose title cannot be read sorts by its file name. */
	function sortTransformations(list: readonly TransformationEntry[]) {
		const key = (entry: TransformationEntry) =>
			entry.fields.title || entry.path;
		return [...list].sort(
			(a, b) =>
				key(a).localeCompare(key(b), undefined, { sensitivity: 'base' }) ||
				(a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
	}

	async function refresh() {
		reading += 1;
		try {
			await readFolder();
		} finally {
			reading -= 1;
		}
	}

	/** The refresh a run of row saves asked for, while it runs. */
	let savedRefresh: Promise<void> | undefined;
	let refreshAgain = false;
	/**
	 * Refresh the lists after a run of row saves ended. Typing saves as it
	 * goes, so runs end often: one refresh runs at a time, and the runs that
	 * end meanwhile share one more after it.
	 */
	function refreshAfterSave() {
		if (savedRefresh !== undefined) {
			refreshAgain = true;
			return;
		}
		savedRefresh = (async () => {
			try {
				do {
					refreshAgain = false;
					await refresh();
				} while (refreshAgain && !closing);
			} finally {
				savedRefresh = undefined;
			}
		})();
	}

	/** Told the recording files a listing found, each time one is read. Never told of a listing that failed. */
	const recordingsListed = new Set<(present: ReadonlySet<string>) => void>();

	async function readFolder() {
		const sequence = ++refreshSequence;
		// Published before this read began, so this read's listing accounts for them.
		const published = new Map(unlistedResults);
		const publishedOutputs = new Map(unlistedOutputs);
		const [
			{ data: recordingListing, error: recordingListError },
			{ data: transcriptListing, error: transcriptListError },
			{ data: fileListing, error: fileListError },
			{ data: storedKv, error: kvError },
			{ data: profileListing, error: profileListError },
			{ data: outputListing, error: outputListError },
			{ data: textOutputListing, error: textOutputListError },
		] = await Promise.all([
			table.list(),
			results.list(),
			folder.files.list(),
			folder.kv.get(),
			profiles.list(),
			outputs.list(),
			textOutputs.list(),
		]);
		if (sequence !== refreshSequence) return;
		// Results on pasted text name no recording, so a file here that cannot be
		// read is reported where they are listed and never holds up a recording's
		// deletion. A listing that failed keeps the last list and says so.
		if (textOutputListError !== null)
			textResultsError = textOutputListError.message;
		else {
			textResultsError = undefined;
			const read = splitListing(textOutputListing);
			textResults = read.entries;
			unreadableTextResults = read.failed;
		}
		// A file that was read is a row to show and open, whether or not its text
		// parses. A file that could not be read has no text and is listed apart.
		if (profileListError !== null) {
			transformationsError = profileListError.message;
		} else {
			transformationsError = undefined;
			const read = splitListing(profileListing);
			transformations = sortTransformations(read.entries);
			unreadableTransformations = read.failed;
			putDownMissingRows(transformationRows, profileListing);
		}
		// A listing that failed keeps the previous observation, as the lists do.
		if (outputListError === null) {
			const read = splitListing(outputListing);
			transformationResults = read.entries;
			noteUnread(outputs.name, read.failed);
			for (const [path, entry] of publishedOutputs)
				if (unlistedOutputs.get(path) === entry) unlistedOutputs.delete(path);
		}
		if (recordingListError !== null) {
			// Keep the previous observation visible; never show an empty list for a failed read.
			listError = recordingListError.message;
		} else {
			listError = undefined;
			const read = splitListing(recordingListing);
			entries = sortEntries(read.entries);
			unreadable = read.failed;
			putDownMissingRows(recordingRows, recordingListing);
			const present = new Set(recordingListing.map((item) => item.path));
			// Only a listing that was read says a file is gone; a failed one says nothing.
			for (const listener of recordingsListed) listener(present);
		}
		if (transcriptListError === null) {
			const read = splitListing(transcriptListing);
			transcriptions = read.entries;
			noteUnread(results.name, read.failed);
			for (const [path, entry] of published)
				if (unlistedResults.get(path) === entry) unlistedResults.delete(path);
			putDownMissingRows(transcriptRows, transcriptListing);
		}
		if (kvError !== null) settingsError = kvError.message;
		else {
			settingsError = undefined;
			kv = storedKv;
		}
		if (fileListError !== null) {
			listingError = fileListError.message;
		} else {
			listingError = undefined;
			listing = fileListing;
			await observeTextDrafts(fileListing, sequence);
		}
		if (sequence === refreshSequence) generation += 1;
	}

	async function refreshAll() {
		await Promise.all([refresh(), folder.git.status()]);
	}

	/**
	 * Select a path: a recording, transcript, or transformation row opens its
	 * one draft, audio opens a player, other files open as text or details. A
	 * transformation has its own selection, so opening one leaves the selected
	 * recording alone.
	 *
	 * A row path stays a row whatever its file holds. When the folder opens no
	 * editor for it because it cannot be read, its `unopened` slot says why
	 * and offers to try again; it is never read or edited as an ordinary file,
	 * which would be a second writer of the row. A row that is gone is
	 * selected with nothing open, and nothing creates it.
	 */
	async function open(path: string) {
		// Nothing is opened once the library is closing: an editor made now
		// would outlive the folder it saves to.
		if (closing) return;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const row = openRowAt(path, { retain: true });
		if (row !== undefined) {
			if (rowStemOf(TRANSFORMATIONS, path) !== undefined)
				selectedTransformationPath = path;
			else selectedPath = path;
			await row;
			return;
		}
		selectedPath = path;
		const known = openFiles.get(path);
		if (known?.kind === 'text' || known?.kind === 'loading') return;
		if (audioMimeTypeOf(path) !== undefined) {
			const size = listing?.files.find((file) => file.path === path)?.size ?? 0;
			openFiles.set(path, { kind: 'audio', size });
			return;
		}
		await load(path);
	}

	/**
	 * Read an ordinary file into the one draft kept for its path.
	 *
	 * No read is begun once the library is closing, and a read that answers
	 * after closing began makes no draft: closing settles and disposes the
	 * drafts that exist when it runs, so one made later would be left with a
	 * save timer and a folder that is gone. The placeholder is dropped; no
	 * typing can have gone into a file that was still being read.
	 */
	async function load(path: string) {
		if (closing) return;
		openFiles.set(path, { kind: 'loading' });
		const { data: opened, error: readError } = await readTextFile(
			folder.files,
			path,
		);
		if (openFiles.get(path)?.kind !== 'loading') return;
		if (closing) {
			openFiles.delete(path);
			return;
		}
		openFiles.set(
			path,
			readError !== null
				? { kind: 'failed', message: readError.message }
				: opened.kind === 'text'
					? { kind: 'text', editor: textEditorOf(opened.file) }
					: opened,
		);
	}

	/**
	 * Put down every draft kept for a path, and its selection. A row write
	 * already admitted still settles in its editor; nothing waits for it here.
	 */
	function forget(path: string) {
		for (const { rows } of rowTables) {
			const slot = rows.get(path);
			if (slot === undefined) continue;
			rows.delete(path);
			if (slot.kind === 'open') slot.editing.release();
		}
		if (selectedTransformationPath === path)
			selectedTransformationPath = undefined;
		const file = openFiles.get(path);
		if (file?.kind === 'text') file.editor.dispose();
		openFiles.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/**
	 * Drop a draft's input for the file as it is now, as the person chose. An
	 * open row takes its file again (`reloadRow`). A row that could not be
	 * opened, and a text draft whose file is gone, are put down. Returns why
	 * nothing changed.
	 */
	async function discardDraft(path: string): Promise<string | undefined> {
		if (!admitting) return LEAVING;
		const slot = slotAt(path);
		if (slot?.kind === 'open') {
			if (claimed.has(path) || settling.has(path) || slot.editing.reloading)
				return `"${basename(path)}" is still working. Nothing was discarded.`;
			if (slot.editing.status.kind === 'removed') {
				forget(path);
				return undefined;
			}
			return reloadRow(path);
		}
		if (slot?.kind === 'unopened') {
			forget(path);
			return undefined;
		}
		const editor = textDraftAt(path);
		if (
			editor?.saveState.kind === 'conflict' &&
			editor.saveState.current === undefined
		)
			forget(path);
		return undefined;
	}

	/**
	 * Run a move or deletion that owns `paths` until it has an outcome. A path
	 * another one owns refuses it before anything is read or written; the
	 * claim is taken with nothing awaited and released however it ends.
	 */
	async function owning(
		paths: readonly string[],
		work: () => Promise<string | undefined>,
	): Promise<string | undefined> {
		const release = claim(paths);
		if (typeof release === 'string') return release;
		try {
			return await work();
		} finally {
			release();
		}
	}

	/**
	 * Claim `paths` for one operation with nothing awaited: a function that
	 * releases the claim, or why a path is taken.
	 */
	function claim(paths: readonly string[]): (() => void) | string {
		const taken = paths.find((path) => claimed.has(path));
		if (taken !== undefined)
			return `"${basename(taken)}" is being moved or deleted. Try again when that has finished. Nothing was changed.`;
		for (const path of paths) claimed.add(path);
		return () => {
			for (const path of paths) claimed.delete(path);
		};
	}

	/** Join an accepted operation, so preparing to leave and closing wait for it. */
	function track<T>(running: Promise<T>): Promise<T> {
		fileChanges = Promise.allSettled([fileChanges, running]);
		return running;
	}

	/**
	 * Write a recovery copy of text under `conflicts/`, exclusively. Text a
	 * file cannot hold exactly (a lone surrogate) is refused before anything
	 * is written.
	 */
	async function writeRecoveryCopy(
		path: string,
		text: string,
	): Promise<Result<string, string>> {
		if (!text.isWellFormed())
			return Err(
				'Your edits contain a character a file cannot hold exactly (a lone surrogate), so no copy was written. They are kept here; fix that character, then copy them again.',
			);
		const copy = conflictCopyPath(path);
		const { error: createError } = await folder.files.create(copy, text);
		if (createError !== null) return Err(describeWriteError(createError));
		return Ok(copy);
	}

	/**
	 * Retire the draft at `path` for its file's deletion: from now until that
	 * has an outcome it takes no typing and writes nothing. `unfence` or
	 * `deleteRetired` ends it.
	 */
	function retire(path: string) {
		fenced.add(path);
		retiring.add(path);
	}

	/**
	 * Delete the file at `path` with its draft retired. The caller checked
	 * that the draft holds nothing and, with nothing awaited since, retired it
	 * or calls this; from then until the outcome it takes no typing and writes
	 * nothing, so no late save reaches the file. A refusal changed nothing
	 * and the draft goes on. A deletion whose reply was lost may or may not
	 * have happened: the draft, which holds nothing, is put down, and what the
	 * folder holds is shown when the person opens the file again.
	 */
	async function deleteRetired(
		path: string,
		remove: () => Promise<Result<undefined, FileError>>,
	): Promise<Result<undefined, string>> {
		retire(path);
		let removed: Result<undefined, FileError>;
		try {
			removed = await remove();
		} catch (cause) {
			unfence(path);
			throw cause;
		}
		const { error: removeError } = removed;
		if (removeError === null || removeError.name === 'Unconfirmed') {
			forget(path);
			fenced.delete(path);
			retiring.delete(path);
			if (removeError === null) return Ok(undefined);
			return Err(
				`The folder did not confirm the deletion of "${basename(path)}", so it may or may not be gone. Nothing else was deleted. Open it again to see what the folder holds.`,
			);
		}
		unfence(path);
		return Err(describeWriteError(removeError));
	}

	/** Let the draft at `path` take input and write again, and save what it held back meanwhile. */
	function unfence(path: string) {
		fenced.delete(path);
		retiring.delete(path);
		textDraftAt(path)?.resume();
	}

	/**
	 * Carry the draft of a moved file to its new path: open a draft there,
	 * hand it the typing the old text draft holds unsaved, and only once the
	 * new draft holds it, put the old one down. A row's editor saved all its
	 * input before the move, so it has nothing to carry and is put down. The
	 * typing was taken before, so it is carried even while new input is not
	 * admitted, as when the page is deciding whether to close. Between reading
	 * that typing and putting the old draft down nothing is awaited. Returns
	 * why it could not be carried; the old draft is then kept with it, writing
	 * nothing and holding the close.
	 *
	 * A draft already kept at `to` belongs to whoever typed into it. It is
	 * read again first, and the typing is carried into it only if, at the
	 * moment of carrying, it holds nothing: no input, no write running or
	 * failed, no unresolved rename. Otherwise both drafts are kept as they are.
	 */
	async function handOff(
		from: string,
		to: string,
		/** The SHA-256 of the file as it was before it moved. */
		expected: string,
	): Promise<string | undefined> {
		const kept = slotAt(to) ?? openFiles.get(to);
		const row = openRowAt(to);
		if (row !== undefined) await row;
		else if (openFiles.get(to)?.kind !== 'text') await load(to);
		/** Whether a row editor kept at `to` could not read the file there again. */
		let unread = false;
		if (kept !== undefined && !draftHolds(to)) {
			// It was opened before the file moved here: read what is there now.
			const editing = rowEditingAt(to);
			if (editing !== undefined)
				unread = (await editing.reload()).error !== null;
			else {
				const editor = textDraftAt(to);
				const { data: opened, error: readError } = await readTextFile(
					folder.files,
					to,
				);
				if (
					editor !== undefined &&
					readError === null &&
					opened.kind === 'text'
				)
					editor.observe(opened.file);
			}
		}
		// The draft at `to` must have read the file as it was before it moved:
		// another program may have written `to` while it was opened or read.
		// This holds for that read; a write after it is not ruled out.
		const destination = rowEditingAt(to);
		const destinationText = destination?.row.text;
		const read =
			destination === undefined
				? textDraftAt(to)?.baseline.sha256
				: unread || destinationText === undefined
					? undefined
					: await textSha256(destinationText);
		// Nothing is awaited from here until the old draft is put down.
		const typed = textDraftAt(from);
		if (typed === undefined || !typed.dirty) {
			forget(from);
			return undefined;
		}
		const text = typed.buffer;
		if (draftHolds(to) || unresolvedMoves.has(to))
			return `"${basename(to)}" has edits of its own open, so your edits from "${basename(from)}" were not moved there. Both are kept, and nothing is saved until you choose.`;
		if (
			read !== expected ||
			(destination !== undefined && destination.row.text !== destinationText)
		)
			return `"${basename(to)}" no longer holds the file as it was, so your edits from "${basename(from)}" were not moved there. Both are kept, and nothing is saved until you choose.`;
		const notCarried = `"${basename(from)}" was renamed to "${basename(to)}", and your typing could not be moved with it, so it stays in the old draft and is not saved.`;
		const carried =
			destination !== undefined
				? destination.carry(text)
				: (textDraftAt(to)?.carry(text) ?? false);
		if (!carried) return notCarried;
		forget(from);
		return undefined;
	}

	/**
	 * Move a file to a new name in its folder. Its draft is settled first and
	 * the file read after that, so the move is conditional on what was settled.
	 * A row's editor takes no input from the start of settling until the move
	 * has an outcome. An ordinary file's draft still takes typing while the file
	 * moves and writes nothing: a save at the old path could recreate it, or
	 * make the move refuse. The draft and that typing then follow the file to
	 * where it is.
	 */
	async function renameFile(
		from: string,
		to: string,
	): Promise<string | undefined> {
		settling.add(from);
		try {
			const { data: settledSha256, error: settleError } =
				await settleDraft(from);
			if (settleError !== null) return settleError;
			let expected = settledSha256;
			if (expected === undefined) {
				const { data: file, error: readError } = await folder.files.read(from);
				if (readError !== null) return readError.message;
				expected = file.sha256;
			}
			// A draft at the new name that holds edits is someone's work: nothing
			// moves onto it. Nothing is awaited from this check to the move.
			if (draftHolds(to) || unresolvedMoves.has(to))
				return `"${basename(to)}" has edits open that are not saved. Save or discard them before renaming another file to that name. Nothing was renamed.`;
			fenced.add(from);
			return moveFenced(from, to, expected);
		} finally {
			settling.delete(from);
		}
	}

	/** The move itself, with the draft at `from` fenced. */
	async function moveFenced(
		from: string,
		to: string,
		expected: string,
	): Promise<string | undefined> {
		const wasSelected = selectedPath === from;
		let moved: Awaited<ReturnType<typeof folder.files.move>>;
		try {
			moved = await folder.files.move({ path: from, sha256: expected }, to);
		} catch (cause) {
			unfence(from);
			throw cause;
		}
		const { error: moveError } = moved;
		/**
		 * Follow the file to `to`, then show it there. When the edits cannot
		 * follow, as when a draft at `to` took typing of its own meanwhile, the
		 * move happened and the edits stay held at the old path, writing
		 * nothing, until the person chooses where they go.
		 */
		const follow = async () => {
			const problem = await handOff(from, to, expected);
			if (problem === undefined) {
				fenced.delete(from);
				await refreshAll();
				if (wasSelected) await open(to);
				return undefined;
			}
			const message = `"${basename(from)}" was renamed to "${basename(to)}". ${problem}`;
			unresolvedMoves.set(from, {
				from,
				to,
				expected,
				message,
				found: await inspectMove(from, to, expected),
			});
			fenced.delete(from);
			await refreshAll();
			return message;
		};
		if (moveError === null) return follow();
		// A refusal changed nothing: the old draft goes on at its file.
		if (
			moveError.name !== 'Unconfirmed' &&
			moveError.name !== 'SourceNotRemoved'
		) {
			unfence(from);
			await refreshAll();
			return describeWriteError(moveError);
		}
		// No reply, or a move that left the file at both paths: the rename did
		// not end as asked, and only the person says where the draft goes. Until
		// then the draft keeps its typing and writes nothing, whatever either
		// path is found to hold: a matching file says what is there now, not
		// what this move did.
		const message =
			moveError.name === 'Unconfirmed'
				? `The folder did not confirm the rename of "${basename(from)}" to "${basename(to)}", so it may or may not have happened.`
				: describeWriteError(moveError);
		// With no text draft open there are no edits to hold: the message is
		// all. A row's editor saved everything it took before the move, and is
		// put down rather than kept on a path the move may have left; opening
		// either path again shows what the folder holds.
		if (textDraftAt(from) === undefined) {
			forget(from);
			fenced.delete(from);
			await refreshAll();
			return message;
		}
		unresolvedMoves.set(from, {
			from,
			to,
			expected,
			message,
			found: await inspectMove(from, to, expected),
		});
		fenced.delete(from);
		await refreshAll();
		return message;
	}

	/** What one path holds, against the file as it was before a move. */
	async function pathState(path: string, expected: string): Promise<PathState> {
		const { data: file, error: readError } = await folder.files.read(path);
		if (readError !== null)
			return readError.name === 'NotFound' ? 'missing' : 'unreadable';
		return file.sha256 === expected ? 'matches' : 'different';
	}

	async function inspectMove(from: string, to: string, expected: string) {
		const [atFrom, atTo] = await Promise.all([
			pathState(from, expected),
			pathState(to, expected),
		]);
		return { from: atFrom, to: atTo };
	}

	/**
	 * End an unresolved rename the way the person chose. Each choice reads
	 * both paths again first and is refused when what it needs is no longer
	 * there: keeping the edits at a path needs that path to hold the file as
	 * it was before the move, so they are never saved over anything else.
	 * Opening a path as it is, or discarding, drops the edits.
	 *
	 * It owns both paths while it runs: it releases the fence at `from`, and
	 * it may carry the edits into the draft at `to`.
	 */
	async function resolveMove(
		from: string,
		choice: MoveChoice,
	): Promise<string | undefined> {
		if (!admitting) return LEAVING;
		const held = unresolvedMoves.get(from);
		if (held === undefined) return 'There is no rename to finish.';
		return track(owning([from, held.to], () => finishMove(held, choice)));
	}

	async function finishMove(
		held: UnresolvedMove,
		choice: MoveChoice,
	): Promise<string | undefined> {
		const { from } = held;
		const found = await inspectMove(held.from, held.to, held.expected);
		if (unresolvedMoves.get(from) !== held)
			return 'This rename was already finished.';
		unresolvedMoves.set(from, { ...held, found });
		const wasSelected = selectedPath === from;
		const end = async (show: string | undefined) => {
			unresolvedMoves.delete(from);
			await refreshAll();
			if (show !== undefined && wasSelected) await open(show);
			return undefined;
		};
		switch (choice) {
			case 'keepAtSource': {
				if (found.from !== 'matches')
					return `"${basename(from)}" does not hold the file as it was, so your edits were not kept there.`;
				unresolvedMoves.delete(from);
				// The draft reads its file again, then saves what it held back.
				const { data: opened, error: readError } = await readTextFile(
					folder.files,
					from,
				);
				if (readError === null && opened.kind === 'text')
					textDraftAt(from)?.observe(opened.file);
				unfence(from);
				await refreshAll();
				return undefined;
			}
			case 'keepAtDestination': {
				if (found.to !== 'matches')
					return `"${basename(held.to)}" does not hold the file as it was, so your edits were not moved there.`;
				const problem = await handOff(from, held.to, held.expected);
				if (problem !== undefined) {
					// Show what the paths hold after the refusal, not before it.
					const after = unresolvedMoves.get(from);
					const now = await inspectMove(held.from, held.to, held.expected);
					// Unless the person ended it meanwhile.
					if (after !== undefined && unresolvedMoves.get(from) === after)
						unresolvedMoves.set(from, { ...after, found: now });
					return problem;
				}
				return end(held.to);
			}
			case 'openSource':
			case 'openDestination': {
				const path = choice === 'openSource' ? from : held.to;
				const state = choice === 'openSource' ? found.from : found.to;
				if (state === 'missing' || state === 'unreadable')
					return `"${basename(path)}" cannot be opened: ${state === 'missing' ? 'there is no file there' : 'it could not be read'}.`;
				forget(from);
				return end(path);
			}
			case 'discard':
				forget(from);
				return end(undefined);
			default:
				return choice satisfies never;
		}
	}

	/**
	 * Write the edits held after an unresolved rename to a new file under
	 * `conflicts/`, then stop tracking the rename. Neither path is written.
	 * The draft takes no input while the copy is written, and is put down
	 * only if it still holds exactly what was copied; anything newer, or a
	 * copy that failed, keeps the draft, its edits, and the rename's hold.
	 * Returns the copy's path.
	 */
	function copyHeldEdits(from: string): Promise<Result<string, string>> {
		if (closing || !admitting) return Promise.resolve(Err(LEAVING));
		const held = unresolvedMoves.get(from);
		if (held === undefined)
			return Promise.resolve(Err('There is no rename to finish.'));
		const release = claim([from]);
		if (typeof release === 'string') return Promise.resolve(Err(release));
		fenced.add(from);
		const editor = textDraftAt(from);
		const buffer = editor?.buffer;
		return track(
			(async (): Promise<Result<string, string>> => {
				try {
					if (buffer === undefined)
						return Err('There are no edits of yours to copy.');
					const written = await writeRecoveryCopy(from, buffer);
					if (written.error !== null) return written;
					const still =
						textDraftAt(from) === editor && editor?.buffer === buffer;
					if (unresolvedMoves.get(from) === held && still) {
						forget(from);
						unresolvedMoves.delete(from);
					}
					await refreshAll();
					return written;
				} finally {
					unfence(from);
					release();
				}
			})(),
		);
	}

	/** Everything held only in this window, in the words the leave prompt shows. */
	function unsavedWork(): string[] {
		const held: string[] = [];
		if (recorder.phase !== 'idle') held.push('A recording is in progress.');
		for (const moved of unresolvedMoves.values())
			held.push(unresolvedHold(moved));
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
		const unsavedOutputs = transcriptRuns().filter(
			(run) => run.state.kind === 'unsaved',
		).length;
		if (unsavedOutputs > 0)
			held.push(
				unsavedOutputs === 1
					? '1 transformation result arrived but its file is not saved.'
					: `${unsavedOutputs} transformation results arrived but their files are not saved.`,
			);
		const unsavedText = textRuns().filter(
			(run) => run.state.kind === 'unsaved',
		).length;
		if (unsavedText > 0)
			held.push(
				unsavedText === 1
					? '1 result on pasted text arrived and is not saved.'
					: `${unsavedText} results on pasted text arrived and are not saved.`,
			);
		if (
			applying.size > 0 ||
			retrying.size > 0 ||
			[...recipeRuns.values()].some((run) => run.state.kind === 'running')
		)
			held.push('A transformation is still running; its result would be lost.');
		for (const editing of rowEditings())
			if (editing.holds) {
				const { kind } = editing.status;
				held.push(
					kind === 'unconfirmed'
						? `${editing.path} has edits whose last save was not confirmed.`
						: kind === 'removed'
							? `${editing.path} has edits whose file is no longer in the folder.`
							: kind === 'saving'
								? `${editing.path} is still being saved.`
								: kind === 'refused'
									? `${editing.path} has a typed value that cannot be saved.`
									: `${editing.path} has edits whose last save failed.`,
				);
			}
		for (const editor of textEditors())
			if (textHolds(editor) && !unresolvedMoves.has(editor.path))
				held.push(
					editor.saveState.kind === 'conflict'
						? `${editor.path} has edits held in a conflict.`
						: editor.saveState.kind === 'unconfirmed'
							? `${editor.path} has edits whose last save was not confirmed.`
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

	/**
	 * How a published recording's row reads now. Looking is the person's
	 * ask, so the row is opened into its editor when none is kept, and a kept
	 * editor holding nothing takes the file as it is now. One whose save is
	 * running or stopped keeps its input, and the file is read beside it.
	 * This writes nothing. "This recording" is judged on the file as read,
	 * never on what the receipts say was written.
	 */
	async function observeRecording(capture: PendingCapture): Promise<
		| { readonly status: 'present' }
		| {
				readonly status: 'unreadable' | 'missing' | 'foreign';
				readonly message: string;
		  }
	> {
		const path = rowPath(RECORDINGS, capture.id);
		const unreadable = (message: string) =>
			({
				status: 'unreadable',
				message: `${path} could not be read: ${message}`,
			}) as const;
		const missing = {
			status: 'missing',
			message: `${path} is no longer in the folder. It was removed after this recording was saved.`,
		} as const;
		let text: string;
		const kept = recordingRows.rows.get(path);
		if (kept?.kind === 'open' && !kept.editing.holds) {
			const { error: reloadError } = await kept.editing.reload();
			if (reloadError?.name === 'NotFound') return missing;
			if (reloadError !== null) return unreadable(reloadError.message);
			text = kept.editing.row.text;
		} else if (kept?.kind === 'open') {
			const { data: entry, error: readError } = await table.get(capture.id);
			if (readError !== null) return unreadable(readError.message);
			if (entry === undefined) return missing;
			text = entry.text;
		} else {
			const slot = await openRow(recordingRows, path);
			switch (slot.kind) {
				case 'missing':
					return missing;
				case 'unopened':
					return unreadable(slot.message);
				case 'opening':
					return unreadable('it is still being opened');
				case 'open':
					text = slot.editing.row.text;
					break;
				default:
					return slot satisfies never;
			}
		}
		if (
			isThisRecording(
				inspectRow(whisperingDefinition.tables.recordings, text),
				capture,
			)
		)
			return { status: 'present' };
		return {
			status: 'foreign',
			message: `${path} was changed after this recording was saved and is no longer this recording.`,
		};
	}

	/**
	 * Show a capture whose two files are in place. The row is read as it is
	 * now: when it is this recording, the capture's notice ends and the row is
	 * selected, unless the person selected something else meanwhile. Anything
	 * else keeps the notice, as saved, and nothing is written for it.
	 */
	async function show(
		item: PendingRecording,
		placed: { readonly audio: InPlace; readonly row: InPlace },
		selectionBefore: string | undefined,
	) {
		const { id } = item.capture;
		let observed: Awaited<ReturnType<typeof observeRecording>>;
		try {
			observed = await observeRecording(item.capture);
		} catch (cause) {
			// A read that throws (the folder host went away) is an unreadable row.
			observed = { status: 'unreadable', message: describe(cause) };
		}
		// Dismissed while the read was running: its result must not restore
		// the notice or change the person's selection.
		if (!pending.some((held) => held.capture.id === id)) return;
		if (observed.status === 'present') {
			setPending(id, undefined);
			await refreshAll();
			// The notice ends, but a newer selection is the person's.
			if (selectedPath === selectionBefore)
				selectedPath = rowPath(RECORDINGS, id);
			return;
		}
		setPending(id, {
			...item,
			state: {
				kind: 'published',
				audio: placed.audio,
				row: placed.row,
				problem: observed.status,
				message: observed.message,
				checking: false,
			},
		});
		await refreshAll();
	}

	/**
	 * One publication attempt for a pending capture. Its id and bytes never
	 * change. The first attempt writes; one the person asks for reads the
	 * folder first and finishes only what is missing.
	 */
	async function publish(item: PendingRecording) {
		const attempt: PendingRecording = {
			...item,
			attempts: item.attempts + 1,
			state: { kind: 'saving' },
		};
		setPending(item.capture.id, attempt);
		const selectionBefore = selectedPath;
		const outcome = await publishRecording(folder, item.capture, {
			retry: item.attempts > 0,
			around: workspace.injection?.aroundRecordingWrite,
		});
		if (outcome.kind === 'published') {
			await show(attempt, outcome, selectionBefore);
			return;
		}
		setPending(item.capture.id, { ...attempt, state: outcome });
		// The audio may have landed before the attempt stopped; show what is there now.
		await refreshAll();
	}

	/**
	 * Look again at a recording whose two files are in place. This reads the
	 * row and nothing else: no write and no request. A row that is this
	 * recording now, with whatever title or notes it has, ends the notice and
	 * is shown. A row that is unreadable, gone, or someone else's is left
	 * exactly as it is and the notice says so.
	 */
	async function reconcile(item: PendingRecording) {
		if (item.state.kind !== 'published' || item.state.checking) return;
		const placed = item.state;
		const selectionBefore = selectedPath;
		setPending(item.capture.id, {
			...item,
			state: { ...placed, checking: true },
		});
		await show(item, placed, selectionBefore);
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
			const { data: existing, error: readError } = await results.get(id);
			if (readError !== null) published = Err(readError.message);
			else if (existing === undefined) {
				const { data: created, error: createError } = await results.create({
					stem: id,
					fields,
					body,
				});
				// The receipt names the bytes sent; the row is how they read.
				published =
					createError !== null
						? Err(describeWriteError(createError))
						: Ok({
								...created,
								...inspectRow(
									whisperingDefinition.tables.transcriptions,
									created.text,
								),
							});
			} else
				published = isThisResult(existing, fields, body)
					? Ok(existing)
					: Err(
							`${existing.path} already exists and is not this transcript. Nothing was overwritten.`,
						);
		} catch (cause) {
			published = Err(describe(cause));
		} finally {
			writingResults.delete(id);
		}
		const { data: saved, error: publishError } = published;
		const stands = runs.get(recording) === admitted;
		if (publishError !== null) {
			if (stands)
				runs.set(recording, {
					kind: 'unsaved',
					id,
					fields,
					text,
					body,
					message: publishError,
					saving: false,
				});
			return;
		}
		// Saved, whatever the listing below reports. There is no await between
		// the write ending and this, so the recording is never without a run, a
		// write, or this row standing in the way of a deletion confirmed earlier.
		unlistedResults.set(saved.path, saved);
		if (stands) runs.delete(recording);
		await refreshAll();
	}

	// --- transformations ----------------------------------------------------

	/**
	 * Result rows being written now, by run id, each naming its recording, or
	 * undefined for a result on pasted text. A discard drops the text but
	 * cannot stop a write already begun, so the recording is not deleted
	 * under one.
	 */
	const writingRuns = new Map<string, string | undefined>();

	/**
	 * Write a received result as `<table>/<run.id>.md`: `transformation_runs/`
	 * for a transcript's run, `text_runs/` for one on pasted text. The row is
	 * created, never updated, so what it came from is untouched. If an earlier
	 * attempt already wrote this exact result, it is recognized and not
	 * written twice; any other file at that path is left as it is. Nothing
	 * here calls the endpoint.
	 *
	 * `admitted` is the run this save was let in under. Its outcome is applied
	 * only while that run still stands, so a save that ends after the run was
	 * discarded restores nothing and removes nothing; a row it wrote stays.
	 */
	async function saveRun(run: Run, text: string, admitted: Run) {
		const body = resultBody(text);
		/** The row as the folder has it, or why it is not known to be there. */
		let published: Result<TransformationRunEntry | TextRunEntry, string>;
		writingRuns.set(
			run.id,
			run.destination === 'transcript' ? run.fields.recordingId : undefined,
		);
		try {
			const { data: existing, error: readError } =
				run.destination === 'transcript'
					? await outputs.get(run.id)
					: await textOutputs.get(run.id);
			if (readError !== null) published = Err(readError.message);
			else if (existing === undefined) {
				const { data: created, error: createError } =
					run.destination === 'transcript'
						? await outputs.create({ stem: run.id, fields: run.fields, body })
						: await textOutputs.create({
								stem: run.id,
								fields: run.fields,
								body,
							});
				// The receipt names the bytes sent; the row is how they read.
				published =
					createError !== null
						? Err(describeWriteError(createError))
						: Ok({
								...created,
								...(run.destination === 'transcript'
									? inspectRow(
											whisperingDefinition.tables.transformation_runs,
											created.text,
										)
									: inspectRow(
											whisperingDefinition.tables.text_runs,
											created.text,
										)),
							});
			} else
				published = isThisResult(existing, run.fields, body)
					? Ok(existing)
					: Err(
							`${existing.path} already exists and is not this result. Nothing was overwritten.`,
						);
		} catch (cause) {
			published = Err(describe(cause));
		} finally {
			writingRuns.delete(run.id);
		}
		const { data: saved, error: publishError } = published;
		const stands = recipeRuns.get(run.id) === admitted;
		if (publishError !== null) {
			if (stands)
				recipeRuns.set(
					run.id,
					withState(run, { kind: 'unsaved', message: publishError, text }),
				);
			return;
		}
		// Saved, whatever the listing below reports. There is no await between
		// the write ending and this, so a deletion confirmed earlier always
		// finds the run, the write, or this row in its way.
		if (run.destination === 'transcript')
			// Read or created in `transformation_runs/` just above.
			unlistedOutputs.set(saved.path, saved as TransformationRunEntry);
		if (stands) recipeRuns.delete(run.id);
		await refreshAll();
	}

	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new Set<string>();
	const BEING_DELETED = 'This recording is being deleted.';

	/**
	 * Why the results of a recording cannot all be named now, or undefined.
	 * Deleting a recording deletes its results, and those are found by the
	 * `recordingId` each result row holds. A row whose text does not parse, or
	 * whose `recordingId` did not validate, might be this recording's; so might
	 * a listed file that could not be read. Not knowing is not the same as
	 * none, so the recording is not deleted until those are repaired or
	 * removed.
	 */
	function unknownResults(): string | undefined {
		const unread = [...resultsUnknown.values()];
		const unsaid = [
			...transcriptions,
			...unlistedResults.values(),
			...transformationResults,
			...unlistedOutputs.values(),
		]
			.filter((row) => row.fields.recordingId === undefined)
			.map((row) => row.path);
		if (unread.length === 0 && unsaid.length === 0) return undefined;
		const reasons = [
			...unread,
			...(unsaid.length > 0
				? [`${unsaid.join(', ')} cannot be read well enough`]
				: []),
		];
		return `Some results cannot be told apart from this recording’s: ${reasons.join('; ')}. Repair or remove them from Files first, so none is left naming a recording that is gone.`;
	}

	/**
	 * Why a recording cannot be deleted now, or undefined. A request still
	 * running, or an answer that is not saved yet, would otherwise write a row
	 * that names a recording that is gone. So would the write of a transcript
	 * or a transformation result that was discarded while it was being saved.
	 * A failed run holds nothing and does not block; it is dropped with the
	 * recording.
	 */
	function recordingBusy(id: string): string | undefined {
		const transcript = runs.get(id);
		if (transcript?.kind === 'running')
			return 'A transcription of this recording is still running. Wait for it to finish, then delete the recording.';
		if (transcript?.kind === 'unsaved')
			return 'A transcript of this recording arrived but its file is not saved. Save it again or discard it in the notice under the header, then delete the recording.';
		if ([...writingResults.values()].includes(id))
			return 'A transcript of this recording is still being written to the folder. Wait for it to finish, then delete the recording.';
		const own = transcriptRuns().filter((run) => run.fields.recordingId === id);
		if (own.some((run) => run.state.kind === 'running'))
			return 'A transformation of this recording’s transcript is still running. Wait for it to finish, then delete the recording.';
		if (own.some((run) => run.state.kind === 'unsaved'))
			return 'A transformation result for this recording arrived but its file is not saved. Save it again or discard it in the notice under the header, then delete the recording.';
		if ([...writingRuns.values()].includes(id))
			return 'A transformation result for this recording is still being written to the folder. Wait for it to finish, then delete the recording.';
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
		const { error: settleError } = await settleDraft(transcriptionPath);
		if (settleError !== null)
			return Err(
				`${transcriptionPath} has edits that are not saved. Resolve them in its file, then run this again.`,
			);
		const { data: transcription, error: readError } =
			await results.get(transcriptionId);
		if (readError !== null) return Err(readError.message);
		if (transcription === undefined)
			return Err('This transcript is no longer in the folder.');
		// What a transformation needs from the transcript is its text and the
		// recording it names. Its other fields may need fixing.
		const input = transcription.body;
		const { recordingId } = transcription.fields;
		if (input === undefined || recordingId === undefined)
			return Err(
				`${transcription.path} needs repair before it can be transformed: its text or the recording it names cannot be read. Fix it from Files.`,
			);
		if (input.trim() === '')
			return Err('This transcript has no text to transform.');
		const { data: recording, error: recordingError } =
			await table.get(recordingId);
		if (recordingError !== null) return Err(recordingError.message);
		if (recording === undefined)
			return Err(
				'The recording this transcript was made from is no longer in the folder.',
			);
		if (deleting.has(recordingId)) return Err(BEING_DELETED);
		return Ok({ transcriptionId, recordingId, input });
	}

	const applying = new SvelteSet<string>();
	const retrying = new SvelteSet<string>();

	/**
	 * One request for a run, from its fixed snapshot: the instructions, the
	 * input, the model, and the text connection's base URL it was prepared
	 * for. It always ends: failed, or received. A transcript's result is then
	 * saved at once; a result on pasted text is held until the person saves
	 * or discards it.
	 */
	async function sendRun(run: Run) {
		const running = withState(run, { kind: 'running' });
		recipeRuns.set(run.id, running);
		const failed = (message: string) => {
			if (recipeRuns.get(run.id) === running)
				recipeRuns.set(run.id, withState(run, { kind: 'failed', message }));
		};
		let answered: Awaited<ReturnType<Workspace['transform']>>;
		try {
			answered = await workspace.transform({
				expectedBaseUrl: run.fields.endpoint,
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
		const { data: answer, error: transformError } = answered;
		if (transformError !== null) {
			failed(transformError.message);
			return;
		}
		if (run.destination === 'transcript') {
			await saveRun(run, answer.text, running);
			return;
		}
		if (recipeRuns.get(run.id) === running)
			recipeRuns.set(
				run.id,
				withState(run, {
					kind: 'unsaved',
					message: undefined,
					text: answer.text,
				}),
			);
	}

	/**
	 * Why a run prepared for `endpoint` would not go out over the text
	 * connection now, or undefined. A run keeps the endpoint it was prepared
	 * for; a connection changed since is never used in its place.
	 */
	function connectionMoved(endpoint: string): string | undefined {
		const text = connections?.text;
		if (text === undefined)
			return `This run was prepared for ${endpoint}, and no text connection is set up now, so it was not sent again.`;
		if (!sameBaseUrl(text.baseUrl, endpoint))
			return `This run was prepared for ${endpoint}, and the text connection is now ${text.baseUrl}, so it was not sent again. Dismiss it and run the transformation again.`;
		return undefined;
	}

	/**
	 * Finish a run that did not end as a saved result: send a failed one again
	 * from its snapshot, or save a received one. See `retryTransformation`.
	 */
	async function retryRun(id: string) {
		if (closing || !admitting) return;
		if (retrying.has(id)) return;
		retrying.add(id);
		try {
			const run = recipeRuns.get(id);
			if (run === undefined) return;
			if (run.state.kind === 'unsaved') {
				await saveRun(run, run.state.text, run);
				return;
			}
			if (run.state.kind !== 'failed') return;
			const stands = () => recipeRuns.get(id) === run;
			const refuse = (message: string) => {
				if (stands())
					recipeRuns.set(id, withState(run, { kind: 'failed', message }));
			};
			const moved = connectionMoved(run.fields.endpoint);
			if (moved !== undefined) {
				refuse(moved);
				return;
			}
			if (run.destination === 'text') {
				await sendRun(run);
				return;
			}
			const { data: source, error: sourceError } = await transformationSource(
				rowPath(TRANSCRIPTIONS, run.fields.transcriptionId),
			);
			if (sourceError !== null) {
				refuse(`${sourceError} Dismiss this run.`);
				return;
			}
			if (
				source.input !== run.fields.input ||
				source.recordingId !== run.fields.recordingId
			) {
				refuse(
					'The transcript changed after this run started, so the same request was not sent again. Dismiss this run and run the transformation again.',
				);
				return;
			}
			// From these checks to the run being listed as running there is no
			// await, so a discard or a deletion either is seen here or sees it.
			if (!stands()) return;
			if (deleting.has(source.recordingId)) {
				refuse(BEING_DELETED);
				return;
			}
			// A close asked during the reads above: the run stays failed, unsent.
			if (!admitting) return;
			await sendRun(run);
		} finally {
			retrying.delete(id);
		}
	}

	/** Settle input, then read the saved transformation an operation acts on. */
	async function transformationForOperation(
		path: string,
	): Promise<Result<TransformationEntry, string>> {
		const { data: settledSha256, error: settleError } = await settleDraft(path);
		if (settleError !== null) return Err(settleError);
		const stem = rowStemOf(TRANSFORMATIONS, path);
		if (stem === undefined) return Err(`${path} is not a transformation.`);
		const { data: transformation, error: readError } = await profiles.get(stem);
		if (readError !== null) return Err(readError.message);
		if (transformation === undefined)
			return Err('This transformation is no longer in the folder.');
		if (settledSha256 !== undefined && transformation.sha256 !== settledSha256)
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(transformation);
	}

	/** Newest first; a row whose time did not validate sorts last. */
	function byNewest<
		TEntry extends { readonly fields: { readonly createdAt?: string } },
	>(list: readonly TEntry[]): TEntry[] {
		const key = (entry: TEntry) => entry.fields.createdAt ?? '';
		return [...list].sort((a, b) => key(b).localeCompare(key(a)));
	}

	return {
		workspace,
		folder,
		terminal,
		autosave,
		/** The microphone the next recording uses, and the test of it. */
		input,
		/** Whether the folder is being read now; the lists show the last read until it ends. */
		get refreshing() {
			return reading > 0;
		},
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
		/**
		 * The transcription endpoint and model an earlier build saved in
		 * `kv.json`, as they read now. Offered when the transcription connection
		 * is set up; never written, and never where a request goes.
		 */
		get legacySettings(): Partial<LegacySettings> {
			return kv?.values ?? {};
		},
		/** Why `kv.json` could not be read, or what in it does not conform. */
		get settingsProblem() {
			if (settingsError !== undefined) return settingsError;
			if (kv === undefined) return undefined;
			if (kv.parseError !== undefined) return kv.parseError.message;
			// No issues is no problem: joining none would read as an empty one.
			if (kv.issues.length === 0) return undefined;
			return kv.issues.map((issue) => issue.message).join('; ');
		},
		/** What this device has set up for requests, never a key. Undefined until read, or when the read failed. */
		get connections() {
			return connections;
		},
		/** Why the connections could not be read; none is assumed meanwhile. */
		get connectionsProblem() {
			return connectionsError;
		},
		/**
		 * Whether a recipe can run now, and with what: the one decision the Run
		 * button, the post-processing choice, a transcript's menu, and the run
		 * itself all use. `recipe` is a listed row or a draft as read.
		 */
		resolve,
		get selectedPath() {
			return selectedPath;
		},
		get selection() {
			return selection();
		},
		/**
		 * The draft kept for a transcript's file, opened on first ask. Nothing
		 * is selected by this: the recording being worked on stays open, and its
		 * transcript is edited beside it. It is the same draft Files shows for
		 * that file, with the same saves, reviews, and hold on leaving.
		 */
		async openTranscript(path: string) {
			if (closing || rowStemOf(TRANSCRIPTIONS, path) === undefined) return;
			await openRow(transcriptRows, path);
		},
		/** The draft kept for a transcript's file, once it has been opened. */
		transcriptAt(path: string): RowSlot<TranscriptionFields> | undefined {
			return transcriptRows.rows.get(path);
		},
		/** Whether the library has begun closing; bulk actions stop admitting queued requests. */
		get closing() {
			return closing;
		},
		/**
		 * Whether new work starts now. Off from the moment the shell asks to
		 * close until the person keeps working; never on again once the page has
		 * said it may close.
		 */
		get admitting() {
			return admitting;
		},
		/**
		 * Start nothing new: no capture, request, retry, file change, terminal
		 * command, commit, or typing. Work already accepted continues and
		 * settles; discarding what is held is still possible.
		 */
		pauseAdmission() {
			admitting = false;
		},
		/** Start admitting new work again, after the person chose to keep working. */
		resumeAdmission() {
			if (closing) return;
			admitting = true;
		},
		/**
		 * Hear which recording files each successful listing of the folder
		 * found. A path not among them has left the folder. A listing that
		 * failed tells nothing, so nothing is taken as gone on its account.
		 */
		onRecordingsListed(
			listener: (present: ReadonlySet<string>) => void,
		): () => void {
			recordingsListed.add(listener);
			return () => recordingsListed.delete(listener);
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
			return transformationPaths.has(path) || transformationRows.rows.has(path);
		},
		get selectedTransformationPath() {
			return selectedTransformationPath;
		},
		/** The transformation being edited, with its listed row when it is still in the folder. */
		get selectedTransformation() {
			const path = selectedTransformationPath;
			if (path === undefined) return undefined;
			const slot = transformationRows.rows.get(path);
			return (
				slot && {
					path,
					slot,
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
		/** Runs on transcripts that are not saved results yet: running, failed, or received and unsaved. */
		get transformationRuns(): TransformationRun[] {
			return transcriptRuns();
		},
		get unsavedTransformations() {
			return transcriptRuns().filter((run) => run.state.kind === 'unsaved')
				.length;
		},
		/** Runs on pasted text that are not saved results yet. A received one waits here for Save. */
		get textRuns(): TextRun[] {
			return textRuns();
		},
		get unsavedTextResults() {
			return textRuns().filter((run) => run.state.kind === 'unsaved').length;
		},
		/** Saved results on pasted text one recipe produced, newest first. They outlive it. */
		textOutputsOf(transformationId: string): TextRunEntry[] {
			return byNewest(
				textResults.filter(
					(entry) => entry.fields.transformationId === transformationId,
				),
			);
		},
		/** Why `text_runs/` could not be listed. The last list read stays; it is never shown as empty. */
		get textResultsError() {
			return textResultsError;
		},
		/** Files in `text_runs/` that could not be read as text. */
		get unreadableTextResults() {
			return unreadableTextResults;
		},
		/** Whether a save or a retry of this run is under way, so another is not offered. */
		isRetrying(id: string) {
			return retrying.has(id);
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
				[...recipeRuns.values()].some((run) => run.state.kind === 'unsaved') ||
				rowEditings().some((editing) => editing.holds) ||
				textEditors().some(textHolds)
			);
		},
		get saving() {
			return (
				rowEditings().some((editing) => editing.save.status === 'saving') ||
				textEditors().some((editor) => editor.saveState.kind === 'saving')
			);
		},
		/**
		 * Drafts whose save needs the person: it failed, was not confirmed, its
		 * file is gone, the file changed under unsaved typing, or the value
		 * typed last has no form a file can hold.
		 */
		get saveProblems() {
			const rows = rowEditings().filter((editing) => {
				switch (editing.status.kind) {
					case 'failed':
					case 'unconfirmed':
					case 'removed':
					case 'refused':
						return true;
					default:
						return false;
				}
			}).length;
			const texts = textEditors().filter(
				(editor) =>
					editor.saveState.kind === 'failed' ||
					editor.saveState.kind === 'unconfirmed' ||
					editor.saveState.kind === 'conflict',
			).length;
			return rows + texts;
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
				// Row writes already admitted always finish, and a stopped one is
				// never tried again for the person; with autosave paused, typing in
				// text drafts is not saved for them either.
				await Promise.all([
					...rowEditings().map((editing) => editing.flush()),
					...(autosave.paused
						? []
						: textEditors().map((editor) => editor.settle())),
				]);
				if (accepted === fileChanges) return unsavedWork().length === 0;
			}
		},
		refresh,
		refreshAll,
		open,
		/**
		 * First read after opening: the folder, then what this device has set
		 * up. Nothing is created and nothing is sent; a connection that is not
		 * set up stays that way until the person saves one.
		 */
		async start() {
			await refreshAll();
			await readConnections();
			// The saved choice only: no microphone is opened or listed at launch.
			await input.load();
		},
		discardDraft,
		reloadRow,
		/**
		 * Renames of ordinary files that did not end as asked: the folder lost
		 * the reply, or left the file at both paths. Each holds its draft's edits
		 * until the person chooses with `resolveMove` or `copyHeldEdits`.
		 */
		get unresolvedMoves(): UnresolvedMove[] {
			return [...unresolvedMoves.values()];
		},
		/** Read both paths of an unresolved rename again, and show what they hold now. */
		async checkMove(from: string) {
			const held = unresolvedMoves.get(from);
			if (held === undefined) return;
			const found = await inspectMove(held.from, held.to, held.expected);
			if (unresolvedMoves.get(from) === held)
				unresolvedMoves.set(from, { ...held, found });
		},
		resolveMove,
		copyHeldEdits,
		/** The whole text of the edits an unresolved rename holds, for copying out. */
		heldText: (from: string) => textDraftAt(from)?.buffer,
		/** Edit a row's whole text instead of its fields, through the same editor. */
		editSource(path: string): string | undefined {
			if (!admitting) return LEAVING;
			return rowEditingAt(path)?.showSource(true);
		},
		/**
		 * Edit a row's fields again after editing its text. Text that still is
		 * not a valid row stays as text and says why.
		 */
		useForm(path: string): string | undefined {
			if (!admitting) return LEAVING;
			return rowEditingAt(path)?.showSource(false);
		},
		/** Open a row again that could not be read when it was opened. */
		async retryOpen(path: string): Promise<string | undefined> {
			if (closing) return LEAVING;
			const opened = await openRowAt(path, { retain: true });
			if (opened?.kind === 'missing') {
				forget(path);
				return `"${basename(path)}" is no longer in the folder.`;
			}
			return opened?.kind === 'unopened' ? opened.message : undefined;
		},

		async startRecording() {
			if (recorder.phase !== 'idle') return;
			if (closing || !admitting) return;
			recorderError = undefined;
			recorder = { phase: 'starting' };
			// A test or a pending enable holds the microphone: release it before the recording opens one.
			input.release();
			const attempt = new AbortController();
			starting = attempt;
			const { data: recording, error: startError } =
				await workspace.capture.start({
					input: input.choice,
					signal: attempt.signal,
				});
			// Cancelled or closed while the microphone was opening: it is not kept.
			if (starting !== attempt) {
				if (startError === null) recording.cancel();
				return;
			}
			starting = undefined;
			if (startError !== null) {
				recorder = { phase: 'idle' };
				recorderError = startError.message;
				input.noteRecordingError(startError);
				return;
			}
			active = recording;
			recorder = { phase: 'recording', startedAt: recording.startedAt };
		},
		/**
		 * Stop, keep the audio in this window, and publish it to the folder.
		 * While new work is not admitted the recording stays as it is: stopping
		 * would start a publication.
		 */
		async stopRecording() {
			if (recorder.phase !== 'recording' || active === undefined) return;
			if (!admitting) return;
			const capture = active;
			active = undefined;
			recorder = { phase: 'stopping' };
			const { data: captured, error: stopError } = await capture.stop();
			recorder = { phase: 'idle' };
			if (stopError !== null) {
				recorderError = stopError.message;
				return;
			}
			await publish(accept(captured, new Date()));
		},
		cancelRecording() {
			starting?.abort();
			starting = undefined;
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
			if (!admitting) return;
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

		/**
		 * Transcribe a recording. It needs only the audio the row names, so the
		 * row's `audioPath` is the one field that has to have validated.
		 */
		async transcribe(entry: RecordingEntry) {
			// No request starts once the library is closing, or while the page
			// decides whether it may. One already sent is not affected: it ends
			// as it would have.
			if (closing || !admitting) return;
			// A transcript names its recording by this ID: the row's literal stem.
			const id = entry.stem;
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
						'This recording’s file names no audio (it has no readable audioPath), so there is nothing to transcribe. Add the audio file’s path in Source.',
				});
				return;
			}
			// The connection as it is now is what this request is prepared for, and
			// what its row records. A connection changed while it is out does not
			// move it: the host sends it only to this base URL.
			const connection = connections?.transcription;
			if (connection === undefined) {
				runs.set(id, {
					kind: 'failed',
					message:
						connectionsError === undefined
							? 'No transcription connection is set up, so nothing was sent. Set one up in Settings, then transcribe.'
							: `The transcription connection could not be read, so nothing was sent: ${connectionsError}`,
				});
				return;
			}
			const used = { baseUrl: connection.baseUrl, model: connection.model };
			const running: TranscriptionRun = { kind: 'running' };
			runs.set(id, running);
			// A run always ends: a transport that throws is a failure to retry,
			// never a request left running.
			let answered: Awaited<ReturnType<Workspace['transcribe']>>;
			try {
				answered = await workspace.transcribe({
					audioPath,
					expectedBaseUrl: used.baseUrl,
					model: used.model,
				});
			} catch (cause) {
				runs.set(id, {
					kind: 'failed',
					message: `The transcription request could not be made: ${cause instanceof Error ? cause.message : String(cause)}`,
				});
				return;
			}
			const { data: answer, error: transcribeError } = answered;
			if (transcribeError !== null) {
				runs.set(id, { kind: 'failed', message: transcribeError.message });
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
						model: used.model,
						endpoint: used.baseUrl,
					} as TranscriptionFields,
					text: answer.text,
					body: resultBody(answer.text),
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
			if (!admitting) return;
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

		/**
		 * A new recipe file: a title and instructions. It names no endpoint and
		 * no model of its own (`null`), so it runs with the text connection and
		 * its model until the person names one.
		 */
		createTransformation: submitFileChange(
			async ({
				title,
				prompt,
			}: {
				title: string;
				prompt: string;
			}): Promise<string | undefined> => {
				const { data: created, error: createError } = await profiles.create({
					fields: { title, model: null, endpoint: null },
					body: prompt,
				});
				if (createError !== null) return describeWriteError(createError);
				await refreshAll();
				await openRow(transformationRows, created.path);
				selectedTransformationPath = created.path;
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
			if (closing) return 'The library is closing.';
			if (!admitting) return LEAVING;
			const pair = JSON.stringify([transcriptionPath, transformationPath]);
			if (applying.has(pair))
				return 'This transformation is already running on this transcript. Run it again when it has finished.';
			applying.add(pair);
			try {
				const { data: profile, error: readError } =
					await transformationForOperation(transformationPath);
				if (readError !== null) return readError;
				// The saved file, against the text connection: what is sent.
				const resolved = resolve(profile);
				if (resolved.kind !== 'ready') return resolved.reason;
				const { data: source, error: sourceError } =
					await transformationSource(transcriptionPath);
				if (sourceError !== null) return sourceError;
				// From this check to the run being listed there is no await, so a
				// deletion either sees this run or is seen here. The reads above
				// were held as running; a close asked meanwhile stops the send.
				if (deleting.has(source.recordingId)) return BEING_DELETED;
				if (!admitting) return LEAVING;
				const at = new Date();
				await sendRun({
					id: recordingId(at),
					destination: 'transcript',
					fields: {
						recordingId: source.recordingId,
						transcriptionId: source.transcriptionId,
						transformationId: profile.stem,
						transformationTitle: resolved.title,
						createdAt: at.toISOString(),
						model: resolved.model,
						endpoint: resolved.endpoint,
						prompt: resolved.prompt,
						input: source.input,
					} as TransformationRunFields,
					state: { kind: 'running' },
				});
				return undefined;
			} finally {
				applying.delete(pair);
			}
		},
		/**
		 * Apply a saved recipe to pasted text. `input` is taken as it is when
		 * this is called; typing afterward does not change what is sent or
		 * saved. The recipe's open edits are saved first and the saved file is
		 * what is sent. The answer is held in this window, with the exact
		 * instructions, input, model, and endpoint, until `saveTextRun` or a
		 * discard; nothing is written to the folder by this. A reason is
		 * returned when nothing was sent.
		 *
		 * One recipe holds at most one result on pasted text at a time: a run
		 * still going, or an answer not yet saved or discarded, refuses a new
		 * one, so a received answer is never replaced.
		 */
		async transformText(
			transformationPath: string,
			input: string,
		): Promise<string | undefined> {
			if (closing) return 'The library is closing.';
			if (!admitting) return LEAVING;
			if (input.trim() === '') return 'Paste some text to run this on.';
			const stem = rowStemOf(TRANSFORMATIONS, transformationPath);
			if (stem === undefined)
				return `${transformationPath} is not a transformation.`;
			const key = JSON.stringify(['text', transformationPath]);
			const held = textRuns().find(
				(run) =>
					run.fields.transformationId === stem && run.state.kind !== 'failed',
			);
			if (applying.has(key) || held?.state.kind === 'running')
				return 'This transformation is already running on pasted text. Run it again when it has finished.';
			if (held !== undefined)
				return 'A result of this transformation on pasted text is waiting. Save or discard it first, so it is not replaced.';
			applying.add(key);
			try {
				const { data: profile, error: readError } =
					await transformationForOperation(transformationPath);
				if (readError !== null) return readError;
				const resolved = resolve(profile);
				if (resolved.kind !== 'ready') return resolved.reason;
				// The read above was held as running; a close asked meanwhile stops the send.
				if (!admitting) return LEAVING;
				// A failed run of this recipe on pasted text held nothing; the new
				// run takes its place.
				for (const run of textRuns())
					if (
						run.fields.transformationId === stem &&
						run.state.kind === 'failed'
					)
						recipeRuns.delete(run.id);
				const at = new Date();
				await sendRun({
					id: recordingId(at),
					destination: 'text',
					fields: {
						transformationId: profile.stem,
						transformationTitle: resolved.title,
						createdAt: at.toISOString(),
						model: resolved.model,
						endpoint: resolved.endpoint,
						prompt: resolved.prompt,
						input,
					} as TextRunFields,
					state: { kind: 'running' },
				});
				return undefined;
			} finally {
				applying.delete(key);
			}
		},
		/**
		 * Save a received result on pasted text as `text_runs/<id>.md`, under
		 * the id fixed when its run began. The endpoint is not called. Saving
		 * again after a save that may have landed finds that exact row and
		 * writes nothing; any other file there is left as it is.
		 */
		async saveTextRun(id: string) {
			const run = recipeRuns.get(id);
			if (run?.destination !== 'text' || run.state.kind !== 'unsaved') return;
			await retryRun(id);
		},
		/**
		 * Finish a run that did not end as a saved result, on a transcript or on
		 * pasted text. A failed request is sent again from its snapshot, but only
		 * while the text connection is still the base URL it was prepared for,
		 * and for a transcript only while the folder still has what it was made
		 * from: the same transcript text, for a recording that is still there.
		 * Otherwise it stays failed and says why. A received result is only
		 * saved: the endpoint is not called, and the file keeps the name it was
		 * given.
		 *
		 * Either way the run stays discardable until it is sent. A run discarded,
		 * or dropped with its recording, while this is under way is not sent,
		 * not restored, and not removed again; a row already being written may
		 * still land.
		 */
		retryTransformation: retryRun,
		/**
		 * Drop a run that is not running. A received result that was not saved
		 * is lost from this window; a write of it already begun may still reach
		 * the folder, and whatever it wrote stays there.
		 */
		discardTransformationRun(id: string) {
			if (recipeRuns.get(id)?.state.kind !== 'running') recipeRuns.delete(id);
		},
		deleteTransformationResult: submitFileChange(
			async (entry: TransformationRunEntry): Promise<string | undefined> => {
				const { error: deleteError } = await outputs.delete(entry.stem, {
					expectedSha256: entry.sha256,
				});
				if (deleteError === null) unlistedOutputs.delete(entry.path);
				await refreshAll();
				return deleteError !== null
					? describeWriteError(deleteError)
					: undefined;
			},
		),
		deleteTextResult: submitFileChange(
			async (entry: TextRunEntry): Promise<string | undefined> => {
				const { error: deleteError } = await textOutputs.delete(entry.stem, {
					expectedSha256: entry.sha256,
				});
				await refreshAll();
				return deleteError !== null
					? describeWriteError(deleteError)
					: undefined;
			},
		),

		/**
		 * Save one connection on this device. Its base URL, model, and key
		 * change together, and a saved key is kept only for the same base URL.
		 * Nothing is sent to the endpoint and nothing is written to the folder.
		 */
		async saveConnection(
			operation: Operation,
			change: ConnectionChange,
		): Promise<string | undefined> {
			if (!admitting) return LEAVING;
			const { data: saved, error: saveError } = await workspace.connections.set(
				operation,
				change,
			);
			if (saveError !== null) return saveError;
			connections = saved;
			connectionsError = undefined;
			return undefined;
		},
		/**
		 * Move the key an earlier build saved into the chosen connections, at
		 * the base URLs the person was shown. It is sent nowhere by this.
		 */
		async adoptLegacyKey(
			targets: LegacyKeyTargets,
		): Promise<string | undefined> {
			if (!admitting) return LEAVING;
			const { data: adopted, error: adoptError } =
				await workspace.connections.adoptLegacyKey(targets);
			if (adoptError !== null) return adoptError;
			connections = adopted;
			connectionsError = undefined;
			return undefined;
		},
		/** Read the connections again, as after a failed read. */
		readConnections,

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
				if (rowPaths.has(path) || recordingRows.rows.has(path))
					return RECORDING_NAME;
				if (transformationPaths.has(path) || transformationRows.rows.has(path))
					return TRANSFORMATION_NAME;
				// Nothing repairs a row's `audioPath` when the file it names moves.
				if (entries.some((entry) => audioPathIn(entry.fields) === path))
					return RECORDING_AUDIO_NAME;
				// The destination too: edits carried there must not land in a
				// draft that a deletion of that path is about to put down.
				return owning([path, to], () => renameFile(path, to));
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
				const { error: createError } = await folder.files.create(path, '');
				if (createError !== null) return describeWriteError(createError);
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
				const { error: mkdirError } = await folder.files.mkdir(path);
				if (mkdirError !== null) return describeWriteError(mkdirError);
				if (directory !== '') expanded.add(directory);
				await refresh();
				return undefined;
			},
		),
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * Pending typing is saved first; a draft that cannot save refuses, so no
		 * deletion discards input. The file is read after that, and what was
		 * read is what a confirmed deletion is conditional on. A row's editor
		 * takes no input while this runs. Only empty folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			if (slotAt(path) === undefined) return captureDeletion(path);
			settling.add(path);
			try {
				return await captureDeletion(path);
			} finally {
				settling.delete(path);
			}
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		remove: submitFileChange(removeConfirmed),
		/** Commit current saved files. Unsaved editor input is not included. */
		commit(): Promise<CommitOutcome> {
			if (!admitting)
				return Promise.resolve({ status: 'blocked', reason: LEAVING });
			return folder.git.commit();
		},
		/**
		 * Save what can still be saved, then release the folder. Every row
		 * write already admitted settles before its editor is put down, and a
		 * stopped one is not tried again. Input that could not be saved, and
		 * audio that could not be published, end with the page; the view asks
		 * before the page is left while either exists.
		 */
		async close() {
			closing = true;
			admitting = false;
			// The microphone first: a file command still being written must not
			// keep a test, an enable, or a recording's microphone open meanwhile.
			input.close();
			starting?.abort();
			starting = undefined;
			active?.cancel();
			await fileChanges;
			// Finish accepted microphone preference saves before closing their workspace.
			await input.saved();
			// A row still opening is never handed a view: its opening is aborted.
			lifetime.abort();
			await Promise.all(rowEditings().map((editing) => editing.flush()));
			for (const editing of rowEditings()) editing.release();
			// The lists a last save asked to refresh read the folder too.
			await savedRefresh;
			for (const editor of textEditors()) {
				await editor.settle();
				editor.dispose();
			}
			unwatch();
			unsubscribe();
			recordingsListed.clear();
			await workspace.close();
		},
	};

	/**
	 * What deleting `path` would remove, captured after its draft settled.
	 *
	 * A recording or transformation path is decided by what its file holds
	 * when it is read here, after settling; neither the last listing nor
	 * whether its editor opened decides it. A row that reads is deleted as a
	 * row: a recording with its results, a transformation without them. A
	 * file that is there and does not read as a row (not text, say) is
	 * removed alone, as the exact bytes read, and its results are kept: they
	 * cannot be told to be this row's any better than before. For a
	 * recording, the same guards hold by its name: nothing running for it,
	 * and nothing new starting while it is removed.
	 */
	async function captureDeletion(
		path: string,
	): Promise<Result<Deletion, string>> {
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
		const recordingStem = rowStemOf(RECORDINGS, path);
		const transformationStem = rowStemOf(TRANSFORMATIONS, path);
		if (recordingStem !== undefined || transformationStem !== undefined) {
			const { error: settleError } = await settleDraft(path);
			if (settleError !== null) return Err(settleError);
		}
		if (recordingStem !== undefined) {
			const { data: entry, error: readError } = await table.get(recordingStem);
			if (readError !== null)
				return captureUnreadableRow(RECORDINGS, path, readError.message);
			if (entry === undefined)
				return Err('This recording is no longer in the folder.');
			const id = entry.stem;
			const busy = recordingBusy(id);
			if (busy !== undefined) return Err(busy);
			// The person is told every result that goes with the recording, so
			// every result has to be known to be this one's or another's.
			const unknown = unknownResults();
			if (unknown !== undefined) return Err(unknown);
			// A result saved since the last listing is named from its
			// publication; once listed, the listed row is the one named.
			const listed = new Set(transcriptions.map((result) => result.path));
			const listedOutputs = new Set(
				transformationResults.map((result) => result.path),
			);
			return Ok({
				kind: 'recording',
				entry,
				results: [
					...transcriptions,
					...[...unlistedResults.values()].filter(
						(result) => !listed.has(result.path),
					),
				].filter((result) => result.fields.recordingId === id),
				outputs: [
					...transformationResults,
					...[...unlistedOutputs.values()].filter(
						(result) => !listedOutputs.has(result.path),
					),
				].filter((result) => result.fields.recordingId === id),
			});
		}
		if (transformationStem !== undefined) {
			const { data: entry, error: readError } =
				await profiles.get(transformationStem);
			if (readError !== null)
				return captureUnreadableRow(TRANSFORMATIONS, path, readError.message);
			if (entry === undefined)
				return Err('This transformation is no longer in the folder.');
			const id = entry.stem;
			return Ok({
				kind: 'transformation',
				entry,
				results:
					transformationResults.filter(
						(result) => result.fields.transformationId === id,
					).length +
					textResults.filter((result) => result.fields.transformationId === id)
						.length,
			});
		}
		const { data: settledSha256, error: settleError } = await settleDraft(path);
		if (settleError !== null) return Err(settleError);
		if (settledSha256 !== undefined)
			return Ok({ kind: 'file', path, sha256: settledSha256 });
		const { data: file, error: readError } = await folder.files.read(path);
		if (readError !== null) return Err(readError.message);
		return Ok({ kind: 'file', path, sha256: file.sha256 });
	}

	/**
	 * Capture a recording or transformation file that is there and does not
	 * read as a row: its exact bytes, which the removal is conditional on.
	 * A file that cannot be read at all cannot be captured, and says so. For
	 * a recording, work running for the recording its name makes it refuses,
	 * as it would for the row.
	 */
	async function captureUnreadableRow(
		rowTable: typeof RECORDINGS | typeof TRANSFORMATIONS,
		path: string,
		problem: string,
	): Promise<Result<Deletion, string>> {
		const recordingId =
			rowTable === RECORDINGS ? rowStemOf(RECORDINGS, path) : undefined;
		const { data: file, error: readError } = await folder.files.read(path);
		if (readError !== null)
			return Err(
				readError.name === 'NotFound'
					? `${basename(path)} is no longer in the folder.`
					: `${path} cannot be read, so it cannot be deleted from here: ${readError.message}`,
			);
		if (recordingId !== undefined) {
			if (deleting.has(recordingId)) return Err(BEING_DELETED);
			const busy = recordingBusy(recordingId);
			if (busy !== undefined) return Err(busy);
		}
		return Ok({
			kind: 'unreadableRow',
			table: rowTable,
			path,
			sha256: file.sha256,
			recordingId,
			problem,
		});
	}

	/** Delete exactly what was confirmed; a file that changed since is refused. */
	async function removeConfirmed(
		deletion: Deletion,
	): Promise<string | undefined> {
		if (deletion.kind === 'folder') {
			const { error: rmdirError } = await folder.files.rmdir(deletion.path);
			await refresh();
			return rmdirError !== null ? describeWriteError(rmdirError) : undefined;
		}
		const path =
			deletion.kind === 'file' || deletion.kind === 'unreadableRow'
				? deletion.path
				: deletion.entry.path;
		// The confirmation is modal, but a save may have started or failed since the capture.
		if (draftHolds(path)) return UNSETTLED;
		if (deletion.kind === 'unreadableRow') {
			// Work for the recording its name makes it may have started since
			// the person was asked; its results would name a row that is gone.
			const id = deletion.recordingId;
			if (id !== undefined) {
				if (deleting.has(id)) return BEING_DELETED;
				const busy = recordingBusy(id);
				if (busy !== undefined) return busy;
			}
			return owning([path], async () => {
				// Nothing new starts for that recording until the removal has an
				// outcome: there is no await between the checks above and this.
				if (id !== undefined) deleting.add(id);
				try {
					// Only this file, as the exact bytes confirmed; its results stay.
					const { error: deleteError } = await deleteRetired(path, () =>
						folder.files.remove({ path, sha256: deletion.sha256 }),
					);
					await refreshAll();
					return deleteError ?? undefined;
				} finally {
					if (id !== undefined) deleting.delete(id);
				}
			});
		}
		if (deletion.kind !== 'recording')
			return owning([path], async () => {
				// A transformation's saved results are separate files and stay.
				const { error: deleteError } = await deleteRetired(path, () =>
					deletion.kind === 'transformation'
						? profiles.delete(deletion.entry.stem, {
								expectedSha256: deletion.entry.sha256,
							})
						: folder.files.remove({ path, sha256: deletion.sha256 }),
				);
				await refreshAll();
				return deleteError ?? undefined;
			});

		// Work may have started or finished since the person was asked. A
		// request that is running, or an answer not saved yet, would write a
		// row naming this recording after it is gone; a result saved since is
		// one the person did not agree to delete.
		const id = deletion.entry.stem;
		if (deleting.has(id)) return BEING_DELETED;
		const busy = recordingBusy(id);
		if (busy !== undefined) return busy;
		// A result that stopped being readable since the person was asked
		// could be this recording's and is not among those confirmed.
		const unknown = unknownResults();
		if (unknown !== undefined) return unknown;
		const confirmed = new Set(
			[...deletion.results, ...deletion.outputs].map((row) => row.path),
		);
		// A result saved since the last listing counts from its publication.
		const unconfirmed = [
			...transcriptions,
			...unlistedResults.values(),
			...transformationResults,
			...unlistedOutputs.values(),
		].some((row) => row.fields.recordingId === id && !confirmed.has(row.path));
		if (unconfirmed)
			return 'A new result was saved for this recording after you were asked. Check it, then delete the recording again.';
		// Each result is deleted as its own file, under the recording's rule:
		// a draft of it that holds anything refuses the whole deletion.
		if ([...confirmed].some(draftHolds)) return UNSETTLED;
		// The recording and every result it takes with it, so a rename of
		// a result cannot run beside this deletion or release its fence.
		return owning([path, ...confirmed], async () => {
			// From here until the rows are gone, nothing new starts for it, and
			// no draft of a result takes typing or writes: there is no await
			// between the checks above and this.
			deleting.add(id);
			/** Results retired and not yet asked to be deleted. */
			const waiting = new Set(confirmed);
			waiting.forEach(retire);
			try {
				// The table removes the row file and nothing else. The audio the row
				// names is an ordinary file; it stays, and Files can delete it.
				const { error: deleteError } = await deleteRetired(path, () =>
					table.delete(deletion.entry.stem, {
						expectedSha256: deletion.entry.sha256,
					}),
				);
				if (deleteError !== null) {
					await refreshAll();
					return deleteError;
				}
				// What failed for this recording held nothing, and has nothing left to retry against.
				if (runs.get(id)?.kind === 'failed') runs.delete(id);
				for (const run of transcriptRuns())
					if (run.fields.recordingId === id && run.state.kind === 'failed')
						recipeRuns.delete(run.id);
				// One file at a time: a refusal keeps that file and its draft, and
				// what was deleted before it stays deleted.
				const leftovers: string[] = [];
				for (const result of deletion.results) {
					waiting.delete(result.path);
					const { error: deleteError } = await deleteRetired(result.path, () =>
						results.delete(result.stem, {
							expectedSha256: result.sha256,
						}),
					);
					if (deleteError !== null) leftovers.push(result.path);
					else unlistedResults.delete(result.path);
				}
				for (const output of deletion.outputs) {
					waiting.delete(output.path);
					const { error: deleteError } = await deleteRetired(output.path, () =>
						outputs.delete(output.stem, {
							expectedSha256: output.sha256,
						}),
					);
					if (deleteError !== null) leftovers.push(output.path);
					else unlistedOutputs.delete(output.path);
				}
				await refreshAll();
				return leftovers.length > 0
					? `The recording was deleted, but these results could not be: ${leftovers.join(', ')}`
					: undefined;
			} finally {
				// The recording was refused, or a deletion threw: what was not
				// reached is unchanged, and its draft goes on.
				waiting.forEach(unfence);
				deleting.delete(id);
			}
		});
	}
}
