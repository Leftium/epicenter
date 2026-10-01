/**
 * The Whispering product state over one opened workspace.
 *
 * Everything shown is an observation of the folder's current files: the
 * recording rows, their transcription results, the settings in `kv.json`, and
 * the listing the file browser shows. They refresh together after saves,
 * terminal commands, window focus, and any change another program makes. The
 * selection is a path; editors are retained per path so a selection change
 * never discards a draft.
 *
 * Two things live only in this window until they reach the folder: unsaved
 * typing, and captured audio that has not been fully published. Both are kept
 * across failures and both block leaving the page.
 *
 * Git status comes from the folder's shared snapshot; this module adds no
 * status cache of its own. A save and its commit are separate outcomes.
 */
import type {
	CommitOutcome,
	Entry,
	FileListing,
	FileVersion,
	GitSnapshot,
	KvSnapshot,
	TableWriteError,
} from '@epicenter/app/files';
import { sameVersion } from '@epicenter/app/files';
import { customAlphabet } from 'nanoid';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import type { ActiveCapture, CapturedAudio } from './capture.js';
import {
	RECORDING_ROW,
	RECORDINGS,
	type RecordingFields,
	recordingIdOf,
	type TranscriptionFields,
	type TranscriptionSettings,
} from './definition.js';
import {
	type Autosave,
	createRecordingEditor,
	createTextFileEditor,
	type RecordingEditor,
	type RecordingEntry,
	stemOf,
	type TextFileEditor,
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
	audioPathOf,
	type PendingCapture,
	publishRecording,
} from './recordings/publish.js';
import { createTerminalSession } from './terminal.svelte.js';
import type { Workspace } from './workspace/index.js';

export type Library = ReturnType<typeof createLibrary>;
export type TranscriptionEntry = Entry<TranscriptionFields>;

/** A raw file the person opened. Recording rows open as recording editors instead. */
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
			readonly entry: RecordingEntry;
			readonly results: readonly TranscriptionEntry[];
	  }
	| {
			readonly kind: 'file';
			readonly path: string;
			readonly version: FileVersion;
	  }
	| { readonly kind: 'folder'; readonly path: string };

/** Captured audio that is not fully in the folder yet. The bytes stay here until it is. */
export type PendingRecording = {
	readonly capture: PendingCapture;
	readonly mimeType: string;
	readonly attempts: number;
	readonly state:
		| { readonly kind: 'saving' }
		/** Nothing from the last attempt reached the folder. */
		| { readonly kind: 'failed'; readonly message: string }
		/** The audio file is saved; the recording's row is not. */
		| {
				readonly kind: 'partial';
				readonly message: string;
				readonly landed: readonly string[];
		  }
		/** Another file occupies this recording's path; nothing was overwritten. */
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

/** One transcription request for a recording, until its result row is saved. */
export type TranscriptionRun =
	| { readonly kind: 'running' }
	| { readonly kind: 'failed'; readonly message: string }
	/** The endpoint answered, but the result row could not be written. */
	| {
			readonly kind: 'unsaved';
			readonly message: string;
			readonly text: string;
			readonly fields: TranscriptionFields;
	  };

const UNSETTLED = 'Save or discard the open edits first.';
const RECORDING_NAME =
	'A recording’s files are named by its ID, which its transcription results refer to. Change the title instead.';

const suffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 4);

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
	if (error.name === 'Conflict')
		return error.expected === 'absent'
			? `"${basename(error.path)}" already exists here.`
			: 'The file changed after it was read, so nothing was changed. Check it and try again.';
	if (error.name === 'DirectoryNotEmpty')
		return 'The folder is not empty, so nothing was deleted.';
	return error.message;
}

export function createLibrary(workspace: Workspace) {
	const { folder } = workspace;
	const table = folder.tables.recordings;
	const results = folder.tables.transcriptions;

	let entries = $state.raw<RecordingEntry[]>([]);
	let transcriptions = $state.raw<TranscriptionEntry[]>([]);
	let unreadable = $state.raw<{ path: string; message: string }[]>([]);
	let listError = $state<string | undefined>();
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
	/** Counts completed folder refreshes; audio players recheck their file on each. */
	let generation = $state(0);
	const autosave = $state<Autosave>({ paused: false });

	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([RECORDINGS]);
	const recordingEditors = new SvelteMap<string, RecordingEditor>();
	const openFiles = new SvelteMap<string, OpenFile>();
	const runs = new SvelteMap<string, TranscriptionRun>();

	const rowPaths = $derived(new Set(entries.map((entry) => entry.path)));
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

	function allEditors(): (RecordingEditor | TextFileEditor)[] {
		const editors: (RecordingEditor | TextFileEditor)[] = [
			...recordingEditors.values(),
		];
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

	async function refresh() {
		const sequence = ++refreshSequence;
		const [rows, found, files, kvRead] = await Promise.all([
			table.list(),
			results.list(),
			folder.files.list(),
			folder.kv.get(),
		]);
		if (sequence !== refreshSequence) return;
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
		if (found.error === null) transcriptions = [...found.data.entries];
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
			editor = createRecordingEditor(
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

	/** Select a path: a recording row opens its editor, audio opens a player, other files open as text or details. */
	async function open(path: string) {
		selectedPath = path;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const known = openFiles.get(path);
		if (
			recordingEditors.has(path) ||
			known?.kind === 'text' ||
			known?.kind === 'loading'
		)
			return;
		let entry = entries.find((item) => item.path === path);
		if (entry === undefined && RECORDING_ROW.test(path)) {
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
		const file = openFiles.get(path);
		if (file?.kind === 'text') file.editor.dispose();
		openFiles.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/** Settle input, then capture current attachment ownership for a file operation. */
	async function recordingForOperation(
		path: string,
	): Promise<Result<RecordingEntry, string>> {
		const editor = recordingEditors.get(path);
		if (editor !== undefined && !(await editor.settle())) return Err(UNSETTLED);
		const read = await table.get(stemOf(path));
		if (read.error) return Err(read.error.message);
		if (read.data === undefined)
			return Err('This recording is no longer in the folder.');
		if (
			editor !== undefined &&
			!sameVersion(read.data.version, editor.baseline.version)
		)
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(read.data);
	}

	async function renameFile(
		from: string,
		to: string,
	): Promise<string | undefined> {
		const editor = textEditorAt(from);
		let expected: FileVersion;
		if (editor !== undefined) {
			if (!(await editor.settle())) return UNSETTLED;
			expected = editor.baseline.version;
		} else {
			const read = await folder.files.read(from);
			if (read.error) return read.error.message;
			expected = read.data.version;
		}
		const moved = await folder.files.move(from, to, { expected });
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
		if (pending.length > 0)
			held.push(
				pending.length === 1
					? '1 recording is not saved to the folder. Its audio is only in this window.'
					: `${pending.length} recordings are not saved to the folder. Their audio is only in this window.`,
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

	/** One publication attempt for a pending capture. Its id and bytes never change. */
	async function publish(item: PendingRecording) {
		const attempt: PendingRecording = {
			...item,
			attempts: item.attempts + 1,
			state: { kind: 'saving' },
		};
		setPending(item.capture.id, attempt);
		const outcome = await publishRecording(folder, item.capture);
		if (outcome.status === 'saved') {
			setPending(item.capture.id, undefined);
			await refreshAll();
			editorFor(outcome.entry);
			selectedPath = outcome.entry.path;
			return;
		}
		setPending(item.capture.id, {
			...attempt,
			state:
				outcome.status === 'partial'
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
		// A partial publication changed the folder; show what is there now.
		await refreshAll();
	}

	function accept(audio: CapturedAudio, endedAt: Date) {
		const item: PendingRecording = {
			capture: {
				id: recordingId(endedAt),
				bytes: audio.bytes,
				extension: audio.extension,
				fields: {
					title: defaultTitle(endedAt),
					recordedAt: endedAt.toISOString(),
					durationMs: audio.durationMs,
					capture: audio.source,
				} as RecordingFields,
			},
			mimeType: audio.mimeType,
			attempts: 0,
			state: { kind: 'saving' },
		};
		setPending(item.capture.id, item);
		return item;
	}

	// --- transcription ------------------------------------------------------

	async function saveResult(
		recording: string,
		fields: TranscriptionFields,
		text: string,
	) {
		const created = await results.create({
			fields,
			body: text.endsWith('\n') ? text : `${text}\n`,
		});
		if (created.error) {
			runs.set(recording, {
				kind: 'unsaved',
				message: describeWriteError(created.error),
				text,
				fields,
			});
			return;
		}
		runs.delete(recording);
		await refreshAll();
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
			return transcriptions
				.filter((entry) => entry.fields.recordingId === id)
				.sort((a, b) =>
					String(b.fields.createdAt ?? '').localeCompare(
						String(a.fields.createdAt ?? ''),
					),
				);
		},
		transcriptionRun(id: string) {
			return runs.get(id);
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
			if (!autosave.paused)
				await Promise.all(allEditors().map((editor) => editor.settle()));
			return unsavedWork().length === 0;
		},
		refresh,
		refreshAll,
		open,
		/** First read after opening: settings exist in `kv.json` from the first launch on. */
		async start() {
			await refreshAll();
			if (kv !== undefined && kv.version === undefined && !kv.issues) {
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
			const editor = recordingEditors.get(path) ?? textEditorAt(path);
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
		/** Publish a pending capture again, under the same id and with the same bytes. */
		async retryPending(id: string) {
			const item = pending.find((candidate) => candidate.capture.id === id);
			if (item === undefined || item.state.kind === 'saving') return;
			await publish(item);
		},
		/** Give up on a pending capture. Files already in the folder are left as they are. */
		discardPending(id: string) {
			setPending(id, undefined);
		},
		pendingAudioPath: audioPathOf,

		async transcribe(entry: RecordingEntry) {
			const id = entry.stem;
			if (id === undefined || runs.get(id)?.kind === 'running') return;
			if (entry.attachment === undefined) {
				runs.set(id, {
					kind: 'failed',
					message: 'This recording has no audio file to transcribe.',
				});
				return;
			}
			const used = settings;
			runs.set(id, { kind: 'running' });
			// A run always ends: a transport that throws is a failure to retry,
			// never a request left running.
			let answered: Awaited<ReturnType<Workspace['transcribe']>>;
			try {
				answered = await workspace.transcribe({
					audioPath: entry.attachment,
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
			await saveResult(
				id,
				{
					recordingId: id,
					createdAt: new Date().toISOString(),
					model: used.transcriptionModel,
					endpoint: used.transcriptionBaseUrl,
				} as TranscriptionFields,
				answered.data.text,
			);
		},
		/** Write a received transcript whose row could not be saved the first time. */
		async retrySaveResult(id: string) {
			const run = runs.get(id);
			if (run?.kind !== 'unsaved') return;
			await saveResult(id, run.fields, run.text);
		},
		dismissRun(id: string) {
			if (runs.get(id)?.kind !== 'running') runs.delete(id);
		},
		async deleteResult(entry: TranscriptionEntry): Promise<string | undefined> {
			const removed = await results.delete(entry);
			await refreshAll();
			return removed.error ? describeWriteError(removed.error) : undefined;
		},

		/** Save folder settings to `kv.json`; a file changed elsewhere is reread once. */
		async saveSettings(
			values: Partial<TranscriptionSettings>,
		): Promise<string | undefined> {
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
		async saveCredential(key: string): Promise<string | undefined> {
			const problem = await workspace.credential.set(key);
			if (problem === undefined) credentialPresent = key !== '';
			return problem;
		},

		/**
		 * Rename a file within its folder. Recording files keep their names; any
		 * other file moves as exact bytes, checked against the version its editor
		 * saw or the version read now.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			if (rowPaths.has(path) || recordingEditors.has(path))
				return RECORDING_NAME;
			const owner = entries.find((entry) => entry.attachment === path);
			if (owner !== undefined) return RECORDING_NAME;
			return renameFile(path, to);
		},
		/** A new empty text file; it never replaces an existing one. */
		async createFile(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (listing?.directories.includes(path))
				return `"${name}" already exists here.`;
			const written = await folder.files.write(path, '', {
				expected: 'absent',
			});
			if (written.error) return describeWriteError(written.error);
			await refreshAll();
			await open(path);
			return undefined;
		},
		async createFolder(
			directory: string,
			name: string,
		): Promise<string | undefined> {
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
				const id = recordingIdOf(path);
				return Ok({
					kind: 'recording',
					entry: entry.data,
					results: transcriptions.filter(
						(result) => result.fields.recordingId === id,
					),
				});
			}
			const text = textEditorAt(path);
			if (text !== undefined) {
				if (!(await text.settle())) return Err(UNSETTLED);
				return Ok({ kind: 'file', path, version: text.baseline.version });
			}
			const read = await folder.files.read(path);
			if (read.error) return Err(read.error.message);
			return Ok({ kind: 'file', path, version: read.data.version });
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		async remove(deletion: Deletion): Promise<string | undefined> {
			if (deletion.kind === 'folder') {
				const removed = await folder.files.rmdir(deletion.path);
				await refresh();
				return removed.error ? describeWriteError(removed.error) : undefined;
			}
			const path =
				deletion.kind === 'recording' ? deletion.entry.path : deletion.path;
			// The confirmation is modal, but a save may have started or failed since the capture.
			const editor = recordingEditors.get(path) ?? textEditorAt(path);
			if (editor && (editor.dirty || editor.saveState.kind !== 'saved'))
				return UNSETTLED;
			const removed =
				deletion.kind === 'recording'
					? await table.delete(deletion.entry)
					: await folder.files.remove(path, { expected: deletion.version });
			if (removed.error) {
				await refreshAll();
				return describeWriteError(removed.error);
			}
			forget(path);
			const leftovers: string[] = [];
			if (deletion.kind === 'recording')
				for (const result of deletion.results) {
					const gone = await results.delete(result);
					if (gone.error) leftovers.push(result.path);
				}
			await refreshAll();
			return leftovers.length > 0
				? `The recording was deleted, but these results could not be: ${leftovers.join(', ')}`
				: undefined;
		},
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
