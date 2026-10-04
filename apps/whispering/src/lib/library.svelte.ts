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
 * (`table.edit`), which owns its document, baseline, reads, and save
 * outcomes; this module decides when it saves and what is reviewed
 * (`row-draft.svelte.ts`). Any other file, and a row that cannot be opened as
 * one, is edited as text.
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
	CanonicalDocument,
	CanonicalValue,
	CommitOutcome,
	DeepReadonly,
	FileError,
	FileListing,
	FileTable,
	GitSnapshot,
	KvSnapshot,
	KvWriteError,
	RowEditor,
	TableEditError,
	TableListing,
	TableSnapshot,
	TableWriteError,
} from '@epicenter/folder';
import { inspectRow, rowPath, rowStemOf } from '@epicenter/folder';
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
import { createRowDraft, type RowDraft } from './row-draft.svelte.js';
import { createTerminalSession } from './terminal.svelte.js';
import type { Workspace } from './workspace/index.js';

export type Library = ReturnType<typeof createLibrary>;
export type RecordingEntry = TableSnapshot<RecordingFields>;
export type TranscriptionEntry = TableSnapshot<TranscriptionFields>;
export type TransformationEntry = TableSnapshot<TransformationFields>;
export type TransformationRunEntry = TableSnapshot<TransformationRunFields>;
export type TextRunEntry = TableSnapshot<TextRunFields>;

/** A raw file the person opened. Recording, transcript, and transformation rows open as rows instead. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: TextFileEditor }
	| { readonly kind: 'audio'; readonly size: number }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

/**
 * The one draft kept for a recording, transcript, or transformation file:
 * the folder's row editor, or the file's text when it cannot be opened as a
 * row or the person chose to edit its source. A path never has both, so
 * every view of the file edits the same draft.
 */
export type RowSlot<TFields> =
	| { readonly kind: 'opening'; readonly done: Promise<void> }
	| { readonly kind: 'form'; readonly draft: RowDraft<TFields> }
	| {
			readonly kind: 'raw';
			readonly editor: TextFileEditor;
			/** Why it could not be opened as a row; undefined when the person chose its source. */
			readonly reason: string | undefined;
	  };

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
 * A rename whose reply was lost, or that left the file at both paths. The
 * draft at `from` holds the edits until the person chooses where they go.
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
 * What a refused `table.edit` leaves. A file whose text has no form the row
 * editor saves, or whose declared fields do not conform, is held as its text
 * for repair. A row that is gone, or a file that cannot be read as text,
 * keeps no draft.
 */
function rowRefusal(
	error: TableEditError,
):
	| { readonly kind: 'raw'; readonly file: SavedText; readonly reason: string }
	| { readonly kind: 'missing' }
	| { readonly kind: 'unopened'; readonly message: string } {
	switch (error.name) {
		case 'NoCanonicalForm':
			return {
				kind: 'raw',
				file: error.file,
				reason: `When opened, its text had no form the fields could be saved in: ${error.refusal.reason}.`,
			};
		case 'InvalidSource':
			return {
				kind: 'raw',
				file: error.file,
				reason: 'When opened, its fields could not be read.',
			};
		case 'NotFound':
			return { kind: 'missing' };
		default:
			return { kind: 'unopened', message: error.message };
	}
}

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
	const admits = () => admitting;
	/**
	 * Paths whose file is being moved or deleted. Their drafts write nothing
	 * until that has an outcome, so no late save recreates the file or moves
	 * it out from under the operation.
	 */
	const fenced = new Set<string>();
	/** Paths whose file is being deleted. Their drafts take no typing either. */
	const retiring = new Set<string>();
	/**
	 * Paths a move or deletion owns, from its admission until it has an
	 * outcome. Only that operation sets or clears their fences, so two of
	 * them never release each other's (`owning`).
	 */
	const claimed = new Set<string>();
	/**
	 * Renames that did not end as asked, by the path whose draft holds the
	 * edits. The draft takes typing and writes nothing, and holds the close,
	 * its source, and its path, until the person chooses where the edits go.
	 */
	const unresolvedMoves = new SvelteMap<string, UnresolvedMove>();
	const typingAt = (path: string) => () => admitting && !retiring.has(path);
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
	/** The rows edited in this window, by path, each with its one retained draft. */
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

	/** Every row draft kept now, with its path. */
	function rowDrafts(): RowDraft<unknown>[] {
		const drafts: RowDraft<unknown>[] = [];
		for (const { rows } of rowTables)
			for (const slot of rows.values())
				if (slot.kind === 'form') drafts.push(slot.draft as RowDraft<unknown>);
		return drafts;
	}

	/** Every text draft kept now: open files, and rows edited as their text. */
	function textEditors(): TextFileEditor[] {
		const editors: TextFileEditor[] = [];
		for (const { rows } of rowTables)
			for (const slot of rows.values())
				if (slot.kind === 'raw') editors.push(slot.editor);
		for (const file of openFiles.values())
			if (file.kind === 'text') editors.push(file.editor);
		return editors;
	}

	/** Whether a text draft holds typing or a save problem that leaving would lose. */
	const textHolds = (editor: TextFileEditor) =>
		editor.dirty || editor.saveState.kind !== 'saved';

	/** The text draft kept for a path: an open file, or a row edited as its text. */
	function textDraftAt(path: string): TextFileEditor | undefined {
		const slot = slotAt(path);
		return slot?.kind === 'raw' ? slot.editor : textEditorAt(path);
	}

	/**
	 * Settle the draft kept for a file, then say which saved version it
	 * settled on: undefined when no draft is kept. A draft whose typing cannot
	 * be saved without the person refuses.
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
		if (slot?.kind === 'form') {
			if (!(await slot.draft.settle())) return Err(UNSETTLED);
			return Ok(slot.draft.state.baseline.sha256);
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
		if (slot?.kind === 'form') return slot.draft.holds;
		const editor = textDraftAt(path);
		return editor !== undefined && textHolds(editor);
	}

	/**
	 * Open the row at `path` into the one draft kept for it, and return it.
	 * The folder's row editor holds it when the file reads as a row it can
	 * save; otherwise its exact text is held for repair. A row that is gone,
	 * or a file that cannot be read as text, keeps no draft and says so.
	 */
	async function openRow<TFields>(
		kind: RowTable<TFields>,
		path: string,
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
		if (known !== undefined) return known;
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
			// Forgotten, or the library closed, while it was opening: it belongs to no view.
			if (rows.get(path) !== opening || closing) {
				if (editError === null) void editor.dispose();
				if (rows.get(path) === opening) rows.delete(path);
				return rows.get(path) ?? { kind: 'missing' };
			}
			if (editError === null) {
				const slot: RowSlot<TFields> = {
					kind: 'form',
					draft: draftOf(kind, path, editor),
				};
				rows.set(path, slot);
				return slot;
			}
			const refused = rowRefusal(editError);
			if (refused.kind === 'raw') {
				const slot: RowSlot<TFields> = {
					kind: 'raw',
					editor: rawEditorOf(refused.file),
					reason: refused.reason,
				};
				rows.set(path, slot);
				return slot;
			}
			rows.delete(path);
			return refused;
		} finally {
			settled();
		}
	}

	function draftOf<TFields>(
		kind: RowTable<TFields>,
		path: string,
		editor: RowEditor<TFields>,
	): RowDraft<TFields> {
		return createRowDraft(editor, {
			files: folder.files,
			autosave,
			admits: typingAt(path),
			writes: writesAt(path),
			onSaved: () => void refresh(),
			// Clean, with a file that is gone or no longer reads as a row: open it
			// again as it is now. Nothing typed is dropped.
			onIdleUnfollowable: () => void reopenRow(kind, path, { chosen: false }),
		});
	}

	/** A text draft of a file, under the same admission and write fences as every draft. */
	function rawEditorOf(file: SavedText): TextFileEditor {
		return createTextFileEditor(
			folder.files,
			file,
			autosave,
			() => void refresh(),
			typingAt(file.path),
			writesAt(file.path),
		);
	}

	/** Put a slot's draft down. A row save already sent still settles. */
	async function disposeSlot(slot: RowSlot<unknown>) {
		if (slot.kind === 'form') await slot.draft.dispose();
		else if (slot.kind === 'raw') slot.editor.dispose();
	}

	/**
	 * Drop the draft kept for a row and open the file again as it is now.
	 * Only the person's choice (`chosen`) puts down a draft that holds
	 * something: typing, a save still out, or a save that failed or was never
	 * answered. Asked for on its own, as when a clean draft's file stops
	 * reading as a row, a draft that holds anything stays as it is, with what
	 * its read found shown as its review.
	 */
	async function reopenRow<TFields>(
		kind: RowTable<TFields>,
		path: string,
		{ chosen }: { chosen: boolean },
	) {
		const slot = kind.rows.get(path);
		if (slot === undefined || slot.kind === 'opening' || closing) return;
		// Its edits wait for the person's choice about where the file went.
		if (unresolvedMoves.has(path)) return;
		if (!chosen && draftHolds(path)) return;
		kind.rows.delete(path);
		const reopened = openRow(kind, path);
		await disposeSlot(slot as RowSlot<unknown>);
		await reopened;
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
	 * Show newer saved text in text drafts, open files' and rows' alike, and
	 * put down clean ones whose files left the folder.
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
		for (const { rows } of rowTables)
			for (const [path, slot] of rows)
				if (slot.kind === 'raw')
					drafts.push({
						path,
						editor: slot.editor,
						putDown: () => rows.delete(path),
					});
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
	 * Bring row drafts up to a listing of their table: a draft whose file the
	 * listing read differently is read again, and a draft holding nothing
	 * whose file left the folder is put down. A draft reads its own file; the
	 * listing only says which to ask.
	 */
	function observeRowDrafts<TFields>(
		kind: RowTable<TFields>,
		listed: TableListing<TFields>,
	): Promise<unknown> {
		const versions = new Map(
			listed.map(({ path, result: { data: entry, error: readError } }) => [
				path,
				readError === null ? entry.sha256 : undefined,
			]),
		);
		const reads: Promise<void>[] = [];
		for (const [path, slot] of kind.rows) {
			if (slot.kind !== 'form' || unresolvedMoves.has(path)) continue;
			const { draft } = slot;
			if (!versions.has(path) && !draft.holds) {
				forget(path);
				continue;
			}
			const { observation } = draft.state;
			const observed =
				observation.kind === 'present'
					? observation.revision.sha256
					: observation.kind === 'invalid' || observation.kind === 'unsupported'
						? observation.file.sha256
						: undefined;
			const version = versions.get(path);
			if (version === undefined || version !== observed)
				reads.push(draft.refresh());
		}
		return Promise.all(reads);
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
		/** Row drafts reading their own files again; this refresh ends after them. */
		const rowReads: Promise<unknown>[] = [];
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
			rowReads.push(observeRowDrafts(transformationRows, profileListing));
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
			rowReads.push(observeRowDrafts(recordingRows, recordingListing));
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
			rowReads.push(observeRowDrafts(transcriptRows, transcriptListing));
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
		await Promise.all(rowReads);
		if (sequence === refreshSequence) generation += 1;
	}

	async function refreshAll() {
		await Promise.all([refresh(), folder.git.status()]);
	}

	/** Whether a row opened into a slot, as opposed to being gone or not text. */
	const isSlot = <TFields>(
		opened: Awaited<ReturnType<typeof openRow<TFields>>>,
	): opened is RowSlot<TFields> =>
		opened.kind === 'opening' ||
		opened.kind === 'form' ||
		opened.kind === 'raw';

	/**
	 * Select a path: a recording, transcript, or transformation row opens its
	 * one draft, audio opens a player, other files open as text or details. A
	 * transformation has its own selection, so opening one leaves the selected
	 * recording alone. A row file that cannot be read as text opens as a file.
	 */
	async function open(path: string) {
		// Nothing is opened once the library is closing: an editor made now
		// would outlive the folder it saves to.
		if (closing) return;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		if (rowStemOf(TRANSFORMATIONS, path) !== undefined) {
			if (isSlot(await openRow(transformationRows, path))) {
				selectedTransformationPath = path;
				return;
			}
			if (closing) return;
			// Not a row that can be read as text: show it as a file.
		}
		selectedPath = path;
		if (rowStemOf(RECORDINGS, path) !== undefined) {
			if (isSlot(await openRow(recordingRows, path)) || closing) return;
		} else if (rowStemOf(TRANSCRIPTIONS, path) !== undefined) {
			if (isSlot(await openRow(transcriptRows, path)) || closing) return;
		}
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
	 * Read a file into the one draft kept for its path. Files, and a
	 * transcript edited beside its recording, both reach a file's text through
	 * this draft, so typing in one is the typing in the other.
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
					? { kind: 'text', editor: rawEditorOf(opened.file) }
					: opened,
		);
	}

	/**
	 * Put down every draft kept for a path, and its selection. A row save
	 * already sent still settles; nothing waits for it here.
	 */
	function forget(path: string) {
		for (const { rows } of rowTables) {
			const slot = rows.get(path);
			if (slot === undefined) continue;
			rows.delete(path);
			void disposeSlot(slot as RowSlot<unknown>);
		}
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
		const { data: settledSha256, error: settleError } = await settleDraft(path);
		if (settleError !== null) return Err(settleError);
		const stem = rowStemOf(RECORDINGS, path);
		if (stem === undefined) return Err(`${path} is not a recording.`);
		const { data: recording, error: readError } = await table.get(stem);
		if (readError !== null) return Err(readError.message);
		if (recording === undefined)
			return Err('This recording is no longer in the folder.');
		if (settledSha256 !== undefined && recording.sha256 !== settledSha256)
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(recording);
	}

	/**
	 * Drop a draft's typing for the file as it is now, as the person chose.
	 * A row draft takes the other version the file holds, or the file as it
	 * is after a save that failed or was never answered, even with nothing
	 * typed since; when the file is gone or no longer reads as a row, it is
	 * opened again as it is. A text draft whose file is gone is put down.
	 * Returns why nothing changed.
	 */
	async function discardDraft(path: string): Promise<string | undefined> {
		if (!admitting) return LEAVING;
		const slot = slotAt(path);
		if (slot?.kind === 'form') {
			const { review } = slot.draft;
			if (review === undefined || review.kind === 'changed') {
				const { error: takeError } = slot.draft.takeCurrent();
				return takeError ?? undefined;
			}
			await withRowTable(path, (kind) =>
				reopenRow(kind, path, { chosen: true }),
			);
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
		const taken = paths.find((path) => claimed.has(path));
		if (taken !== undefined)
			return `"${basename(taken)}" is being moved or deleted. Try again when that has finished. Nothing was changed.`;
		for (const path of paths) claimed.add(path);
		try {
			return await work();
		} finally {
			for (const path of paths) claimed.delete(path);
		}
	}

	/**
	 * Retire the draft at `path` for its file's deletion: from now until that
	 * has an outcome it takes no typing and writes nothing. `release` or
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
	 * nothing, so no late save recreates the file. A refusal changed nothing
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
			release(path);
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
		release(path);
		return Err(describeWriteError(removeError));
	}

	/** Let the draft at `path` write again, and save what it held back meanwhile. */
	function release(path: string) {
		fenced.delete(path);
		retiring.delete(path);
		const slot = slotAt(path);
		if (slot?.kind === 'form') slot.draft.resume();
		else textDraftAt(path)?.resume();
	}

	/** What the draft kept for `path` holds beyond its file now: typing to carry along. */
	function typedAt(path: string):
		| {
				readonly document: DeepReadonly<CanonicalDocument> | undefined;
				readonly text: string;
		  }
		| undefined {
		const slot = slotAt(path);
		if (slot?.kind === 'form')
			return slot.draft.isDirty
				? { document: slot.draft.state.document, text: slot.draft.state.text }
				: undefined;
		const editor = textDraftAt(path);
		return editor?.dirty
			? { document: undefined, text: editor.buffer }
			: undefined;
	}

	/**
	 * Carry the draft of a moved file to its new path: open a draft there,
	 * hand it the typing the old draft already took, and only once the new
	 * draft holds that typing, put the old one down. The typing was accepted
	 * before, so it is carried even while new input is not admitted, as when
	 * the page is deciding whether to close. Between reading that typing and
	 * putting the old draft down nothing is awaited. Returns why the typing
	 * could not be carried; the old draft is then kept with it, writing
	 * nothing and holding the close.
	 *
	 * A draft already kept at `to` belongs to whoever typed into it. It is
	 * read again first, and the typing is carried into it only if, at the
	 * moment of carrying, it holds nothing: no typing, no failed or unknown
	 * save, no unresolved rename. Otherwise both drafts are kept as they are.
	 */
	async function handOff(
		from: string,
		to: string,
		/** The SHA-256 of the file as it was before it moved. */
		expected: string,
	): Promise<string | undefined> {
		const kept = slotAt(to) ?? openFiles.get(to);
		const row = withRowTable(to, (kind) => openRow(kind, to));
		if (row !== undefined) await row;
		else if (openFiles.get(to)?.kind !== 'text') await load(to);
		if (kept !== undefined && !draftHolds(to)) {
			// It was opened before the file moved here: read what is there now.
			const slot = slotAt(to);
			if (slot?.kind === 'form') await slot.draft.refresh();
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
		// Nothing is awaited from here until the old draft is put down.
		const typed = typedAt(from);
		if (typed === undefined) {
			forget(from);
			return undefined;
		}
		if (draftHolds(to) || unresolvedMoves.has(to))
			return `"${basename(to)}" has edits of its own open, so your edits from "${basename(from)}" were not moved there. Both are kept, and nothing is saved until you choose.`;
		// The draft at `to` must have read the file as it was before it moved:
		// another program may have written `to` while it was opened or read.
		// This holds for that read; a write after it is not ruled out.
		const destination = slotAt(to);
		const read =
			destination?.kind === 'form'
				? destination.draft.state.baseline.sha256
				: destination?.kind === 'raw'
					? destination.editor.baseline.sha256
					: textDraftAt(to)?.baseline.sha256;
		if (read !== expected)
			return `"${basename(to)}" no longer holds the file as it was, so your edits from "${basename(from)}" were not moved there. Both are kept, and nothing is saved until you choose.`;
		const notCarried = `"${basename(from)}" was renamed to "${basename(to)}", and your typing could not be moved with it, so it stays in the old draft and is not saved.`;
		const slot = slotAt(to);
		if (slot?.kind === 'form' && typed.document !== undefined) {
			// The whole typed document, so a field the typing removed goes too.
			const fields: Record<string, CanonicalValue | undefined> = {};
			for (const key of Object.keys(slot.draft.state.document.fields))
				fields[key] = undefined;
			Object.assign(fields, typed.document.fields);
			if (!slot.draft.carry({ fields, body: typed.document.body }))
				return notCarried;
			forget(from);
			return undefined;
		}
		if (slot?.kind === 'form') {
			// The old draft was the file's text, so the new one is too.
			const { baseline } = slot.draft.state;
			const text = rawEditorOf({
				path: to,
				sha256: baseline.sha256,
				text: baseline.text,
			});
			if (!text.carry(typed.text)) return notCarried;
			withRowTable(to, ({ rows }) =>
				rows.set(to, { kind: 'raw', editor: text, reason: undefined }),
			);
			void disposeSlot(slot);
			forget(from);
			return undefined;
		}
		const editor = textDraftAt(to);
		if (editor === undefined || !editor.carry(typed.text)) return notCarried;
		forget(from);
		return undefined;
	}

	/**
	 * Move a file to a new name in its folder. Its draft is settled first. While
	 * the file moves, the draft still takes typing and writes nothing: a save at
	 * the old path could recreate it, or make the move refuse. The draft and
	 * that typing then follow the file to where it is.
	 */
	async function renameFile(
		from: string,
		to: string,
	): Promise<string | undefined> {
		const { data: settledSha256, error: settleError } = await settleDraft(from);
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
		const wasSelected = selectedPath === from;
		fenced.add(from);
		let moved: Awaited<ReturnType<typeof folder.files.move>>;
		try {
			moved = await folder.files.move({ path: from, sha256: expected }, to);
		} catch (cause) {
			release(from);
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
			release(from);
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
		// With no draft open there are no edits to hold: the message is all.
		if (slotAt(from) === undefined && textDraftAt(from) === undefined) {
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
		return owning([from, held.to], () => finishMove(held, choice));
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
				const slot = slotAt(from);
				if (slot?.kind === 'form') await slot.draft.refresh();
				else {
					const { data: opened, error: readError } = await readTextFile(
						folder.files,
						from,
					);
					if (readError === null && opened.kind === 'text')
						textDraftAt(from)?.observe(opened.file);
				}
				release(from);
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

	/** The whole text a draft holds now, typed or not. */
	function draftText(path: string): string | undefined {
		const slot = slotAt(path);
		if (slot?.kind === 'form') return slot.draft.state.text;
		return textDraftAt(path)?.buffer;
	}

	/**
	 * Write the edits held after an unresolved rename to a new file under
	 * `conflicts/`, then stop tracking the rename. Neither path is written.
	 * Returns the copy's path.
	 */
	async function copyHeldEdits(from: string): Promise<Result<string, string>> {
		if (!admitting) return Err(LEAVING);
		const held = unresolvedMoves.get(from);
		const text = draftText(from);
		if (held === undefined || text === undefined)
			return Err('There is no rename to finish.');
		const copy = conflictCopyPath(from);
		const { error: createError } = await folder.files.create(copy, text);
		if (createError !== null) return Err(describeWriteError(createError));
		if (unresolvedMoves.get(from) === held) {
			forget(from);
			unresolvedMoves.delete(from);
		}
		await refreshAll();
		return Ok(copy);
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
		// A draft held by an unresolved rename was listed with the rename above.
		for (const draft of rowDrafts())
			if (draft.holds && !unresolvedMoves.has(draft.path))
				held.push(
					draft.review !== undefined
						? `${draft.path} has edits held in a conflict.`
						: draft.status.kind === 'unconfirmed'
							? `${draft.path} has edits whose last save was not confirmed.`
							: draft.status.kind === 'failed'
								? `${draft.path} has edits whose last save failed.`
								: `${draft.path} has unsaved edits.`,
				);
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
	 * How a published recording's row reads now, through the one draft kept
	 * for it: opened when none is kept, read again when one is. This only
	 * reads. "This recording" is judged on the file as read, never on what the
	 * receipts say was written.
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
		const kept = recordingRows.rows.get(path);
		if (kept?.kind === 'form') await kept.draft.refresh();
		const slot =
			kept === undefined || kept.kind === 'opening'
				? await openRow(recordingRows, path)
				: kept;
		let text: string;
		switch (slot.kind) {
			case 'missing':
				return missing;
			case 'unopened':
				return unreadable(slot.message);
			case 'opening':
				return unreadable('it is still being opened');
			case 'form': {
				const { observation } = slot.draft.state;
				if (observation.kind === 'missing') return missing;
				if (observation.kind === 'unreadable')
					return unreadable(observation.error.message);
				text =
					observation.kind === 'present'
						? observation.revision.text
						: observation.file.text;
				break;
			}
			case 'raw': {
				const { data: opened, error: readError } = await readTextFile(
					folder.files,
					path,
				);
				if (readError !== null)
					return readError.name === 'NotFound'
						? missing
						: unreadable(readError.message);
				if (opened.kind !== 'text')
					return unreadable('it is not text the app can read');
				slot.editor.observe(opened.file);
				text = opened.file.text;
				break;
			}
			default:
				return slot satisfies never;
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
				rowDrafts().some((draft) => draft.holds) ||
				textEditors().some(textHolds)
			);
		},
		get saving() {
			return (
				rowDrafts().some((draft) => draft.status.kind === 'saving') ||
				textEditors().some((editor) => editor.saveState.kind === 'saving')
			);
		},
		/**
		 * Drafts whose save needs the person: it failed, was not confirmed, or
		 * the file changed under typing. A row draft whose failed or unknown
		 * save a later read found the file holding is not counted here. That
		 * read confirms nothing: the draft still holds, so `unsaved` and the
		 * leave prompt still count it.
		 */
		get saveProblems() {
			const rows = rowDrafts().filter(({ status }) => {
				switch (status.kind) {
					case 'failed':
					case 'unconfirmed':
						return !status.inFile;
					case 'changed':
					case 'removed':
					case 'unreadable':
					case 'unrecognized':
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
				if (!autosave.paused)
					await Promise.all([
						...rowDrafts().map((draft) => draft.settle()),
						...textEditors().map((editor) => editor.settle()),
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
		/**
		 * Renames that did not end as asked: the folder lost the reply, or left
		 * the file at both paths. Each holds its draft's edits until the person
		 * chooses with `resolveMove` or `copyHeldEdits`.
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
		heldText: draftText,
		/**
		 * Keep both versions of a row in question: write the typing to a copy
		 * under `conflicts/`, then drop it from the draft as `discardDraft` does.
		 * Returns the copy's path.
		 */
		async keepDraftCopy(path: string): Promise<Result<string, string>> {
			const slot = slotAt(path);
			if (slot?.kind !== 'form') return Err('There is no draft to copy.');
			const copied = await slot.draft.keepCopy();
			const { data: copyPath, error: copyError } = copied;
			if (copyError !== null) return copied;
			const discarded = await discardDraft(path);
			if (discarded !== undefined)
				return Err(
					`Your edits were saved to ${copyPath}, and kept here: ${discarded}`,
				);
			return copied;
		},
		/**
		 * Edit a row's whole text instead of its fields. Only a draft holding
		 * nothing unsaved switches. The text is the file's as it is read now.
		 */
		async editSource(path: string): Promise<string | undefined> {
			if (!admitting) return LEAVING;
			const switched = await withRowTable(path, async (kind) => {
				const slot = kind.rows.get(path);
				if (slot?.kind !== 'form') return undefined;
				const free = () => !draftHolds(path) && slot.draft.review === undefined;
				if (!free()) return UNSETTLED;
				const { data: opened, error: readError } = await readTextFile(
					folder.files,
					path,
				);
				if (readError !== null) return readError.message;
				if (opened.kind !== 'text')
					return 'This file is not text that can be edited here.';
				// Typing or a reopening while it was read keeps the draft as it is.
				if (kind.rows.get(path) !== slot || !free() || closing)
					return UNSETTLED;
				kind.rows.set(path, {
					kind: 'raw',
					editor: rawEditorOf(opened.file),
					reason: undefined,
				});
				await disposeSlot(slot as RowSlot<unknown>);
				return undefined;
			});
			return switched;
		},
		/**
		 * Edit a row's fields again after editing its text. Only text with
		 * nothing unsaved switches; when it still cannot be edited as fields,
		 * it stays as text and says why.
		 */
		async useForm(path: string): Promise<string | undefined> {
			if (!admitting) return LEAVING;
			return withRowTable(path, async (kind) => {
				const slot = kind.rows.get(path);
				if (slot?.kind !== 'raw') return undefined;
				if (draftHolds(path)) return UNSETTLED;
				await reopenRow(kind, path, { chosen: true });
				return undefined;
			});
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
			if (recordingRows.rows.has(path) || rowPaths.has(path)) {
				const { data: entry, error: entryError } =
					await recordingForOperation(path);
				if (entryError !== null) return Err(entryError);
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
			if (transformationRows.rows.has(path) || transformationPaths.has(path)) {
				const { data: entry, error: entryError } =
					await transformationForOperation(path);
				if (entryError !== null) return Err(entryError);
				const id = entry.stem;
				return Ok({
					kind: 'transformation',
					entry,
					results:
						transformationResults.filter(
							(result) => result.fields.transformationId === id,
						).length +
						textResults.filter(
							(result) => result.fields.transformationId === id,
						).length,
				});
			}
			const { data: settledSha256, error: settleError } =
				await settleDraft(path);
			if (settleError !== null) return Err(settleError);
			if (settledSha256 !== undefined)
				return Ok({ kind: 'file', path, sha256: settledSha256 });
			const { data: file, error: readError } = await folder.files.read(path);
			if (readError !== null) return Err(readError.message);
			return Ok({ kind: 'file', path, sha256: file.sha256 });
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		remove: submitFileChange(
			async (deletion: Deletion): Promise<string | undefined> => {
				if (deletion.kind === 'folder') {
					const { error: rmdirError } = await folder.files.rmdir(deletion.path);
					await refresh();
					return rmdirError !== null
						? describeWriteError(rmdirError)
						: undefined;
				}
				const path =
					deletion.kind === 'file' ? deletion.path : deletion.entry.path;
				// The confirmation is modal, but a save may have started or failed since the capture.
				if (draftHolds(path)) return UNSETTLED;
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
				].some(
					(row) => row.fields.recordingId === id && !confirmed.has(row.path),
				);
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
							const { error: deleteError } = await deleteRetired(
								result.path,
								() =>
									results.delete(result.stem, {
										expectedSha256: result.sha256,
									}),
							);
							if (deleteError !== null) leftovers.push(result.path);
							else unlistedResults.delete(result.path);
						}
						for (const output of deletion.outputs) {
							waiting.delete(output.path);
							const { error: deleteError } = await deleteRetired(
								output.path,
								() =>
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
						waiting.forEach(release);
						deleting.delete(id);
					}
				});
			},
		),
		/** Commit current saved files. Unsaved editor input is not included. */
		commit(): Promise<CommitOutcome> {
			if (!admitting)
				return Promise.resolve({ status: 'blocked', reason: LEAVING });
			return folder.git.commit();
		},
		/**
		 * Save what can still be saved, then release the folder. A draft that
		 * cannot save and audio that could not be published end with the page;
		 * the view asks before the page is left while either exists.
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
			for (const draft of rowDrafts()) {
				await draft.settle();
				await draft.dispose();
			}
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
}
