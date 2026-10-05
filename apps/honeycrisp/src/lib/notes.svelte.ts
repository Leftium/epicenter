/**
 * The Honeycrisp product state over one opened notes folder.
 *
 * Three observations refresh together: note rows, folder rows, and the file
 * listing the file browser shows. They refresh when the folder hints that
 * files changed, as it does for this page's own saves, after terminal
 * commands and file changes, and when the window regains focus. Hints share
 * one background pass. Every open text file's session is told what the refresh
 * found, so a clean one follows the file and a dirty one keeps its text. An
 * open note is not: its editor keeps its text until the person reloads it.
 *
 * Every opened file has one session, kept by path, and never two:
 *
 * - A note is a row editor (`folder.tables.notes.edit`) retained in a
 *   `NoteSession`. Its title, folder, pin, rich-text, and Source controls,
 *   and its file view, all change that one editor's input at once; a
 *   structured change gives it the complete canonical document, and the file
 *   view its exact text. A note whose text does not read as one opens the
 *   same editor and is repaired in its file view. Opening a note writes
 *   nothing.
 * - Every other text file is a raw `FileSession` over the file's exact text,
 *   whose saves are conditional on the version it read.
 *
 * A field change to a row with no session (a pin from the list, a folder's
 * name) assigns those fields in the row's current text with the table's
 * `update`, once; a new note or folder is created by its table. A change to
 * any other file with no session (a rename or delete from the file browser)
 * is one call on a capture. When the
 * folder cannot say whether it happened, it is kept in `pending`. It is never
 * reported as failed, never sent again by itself, and never replaced by a new
 * one with a fresh name.
 *
 * Selecting another file never discards a session, and rename, delete, and
 * close settle or refuse instead of dropping input.
 */
import {
	type TextCapture as Capture,
	type FileCapture,
	type FileListing,
	type GitSnapshot,
	inspectRow,
	rowPath,
	rowStemOf,
	submittedText,
	type TableEditError,
	type TableUpdateError,
	type TableWriteOptions,
} from '@epicenter/folder';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
} from '@epicenter/folder/file-browser';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FolderEntry,
	type FolderFields,
	folderLabel,
	honeycrispDefinition,
	NOTES,
	type NoteEntry,
	type NoteFields,
	noteIdOf,
	notePath,
	instantNow as now,
} from './data.js';
import {
	ask,
	createFile,
	createFileSession,
	type FileOutcome,
	type FileSession,
	makeDirectory,
	moveFile,
	removeDirectory,
	removeFile,
} from './file-session.svelte.js';
import { nameProblem, readTextFile } from './files.js';
import {
	createNoteSession,
	type NoteEditor,
	type NoteSession,
	noteSaveProblem,
} from './note-session.svelte.js';
import { displayTitle } from './note-source.js';
import type { NotesHost } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Notes = ReturnType<typeof createNotes>;
export type { NoteSession };

/** An opened file, including notes. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| {
			readonly kind: 'note';
			readonly session: NoteSession;
			/**
			 * Which note this is to a view, kept when a rename hands the note to
			 * a session at its new path, so the view and its undo history stay.
			 */
			readonly key: object;
	  }
	| { readonly kind: 'text'; readonly session: FileSession }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number }
	| {
			/**
			 * A note's text the person saved as a new file, which then did not
			 * open. The text stays here exactly as it was saved, read-only and
			 * counted at close, until the note opens or the person dismisses it.
			 * A listing that fails or no longer shows the file does not drop it.
			 */
			readonly kind: 'unopened';
			readonly text: string;
			readonly message: string;
			readonly key: object;
	  };

export type Selection =
	| {
			readonly kind: 'note';
			readonly session: NoteSession;
			/** The same across a rename; a view of this note is keyed on it. */
			readonly key: object;
	  }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

type Table = 'notes' | 'folders';

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| {
			readonly kind: 'file';
			/** The file as it was when the person was asked. */
			readonly file: FileCapture;
			/** The note's name, when the file is a note. */
			readonly title: string | undefined;
	  }
	| { readonly kind: 'folder'; readonly path: string };

/** One change to a file or directory, as it was asked for. */
type SentChange =
	| { readonly kind: 'create'; readonly path: string; readonly source: string }
	| {
			/** A new row, created by its table. */
			readonly kind: 'createRow';
			readonly table: Table;
			readonly path: string;
			readonly stem: string;
			readonly fields: NoteFields | FolderFields;
	  }
	| {
			/** Fields of a row with no open session, assigned in its current text. */
			readonly kind: 'changeRow';
			readonly table: Table;
			readonly path: string;
			readonly stem: string;
			readonly fields: Partial<NoteFields> | Partial<FolderFields>;
			/**
			 * `{}` when the values stand on their own; `{ expectedSha256 }` when
			 * they were derived from a listed snapshot. A resend keeps it.
			 */
			readonly options: TableWriteOptions;
	  }
	| { readonly kind: 'move'; readonly from: FileCapture; readonly to: string }
	| { readonly kind: 'remove'; readonly from: FileCapture }
	| { readonly kind: 'mkdir' | 'rmdir'; readonly path: string };

/**
 * A change to a file with no open session whose outcome the folder could not
 * confirm, or a move that kept its source. It is history: it stands until the
 * person dismisses it, or asks for it again and that is confirmed. A read that
 * finds what it asked for says what the folder holds now (`found`), never
 * that this change did it. A `move`, `remove`, or `rmdir` cannot be asked for
 * again: nothing that can be read shows it will not still happen.
 */
export type PendingChange = SentChange & {
	/** What the person asked for, in words they would use. */
	readonly label: string;
	/**
	 * `sourceNotRemoved`: a move put the bytes at its destination and could
	 * not remove its source, so both paths hold them.
	 */
	readonly state: 'unconfirmed' | 'sourceNotRemoved';
	readonly problem: string;
};

const UNSETTLED = 'Save or discard the open edits first.';
const CLOSING = 'The app is closing, so nothing was changed.';
const NOTE_CHANGED =
	'The file holds other text than this note shows, so nothing was changed. Reload the file to see it.';
const FOLDERS = 'folders';
const NEW_NOTE = 'New note';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

/** The paths a change names: nothing else is changed there while it is pending. */
function pathsOf(change: SentChange): string[] {
	switch (change.kind) {
		case 'move':
			return [change.from.path, change.to];
		case 'remove':
			return [change.from.path];
		default:
			return [change.path];
	}
}

/** The folder's reply in words a person can act on, or undefined when it is done. */
function problemOf(
	outcome: FileOutcome<unknown> | { readonly kind: 'unsettled' },
): string | undefined {
	switch (outcome.kind) {
		case 'done':
			return undefined;
		case 'unsettled':
			return UNSETTLED;
		case 'refused':
			return outcome.occupied !== undefined
				? `"${basename(outcome.occupied)}" already exists here.`
				: 'The file changed after it was read, so nothing was changed. Check it and try again.';
		case 'unconfirmed':
			return `This was not confirmed, so it may or may not have happened. ${outcome.message}`;
		case 'sourceNotRemoved':
			// Only a move ends this way: both of its paths hold the bytes.
			return `"${basename(outcome.to)}" was created, but "${basename(outcome.from)}" could not be removed, so both files hold the same text now. Nothing more is changed at either path from here; look in Files.`;
		default:
			return outcome.message;
	}
}

/** Whether a pending change can be asked for again from the status menu. */
export function canResend(
	change: PendingChange,
): change is Exclude<PendingChange, { kind: 'move' | 'remove' }> {
	return (
		change.state === 'unconfirmed' &&
		(change.kind === 'create' ||
			change.kind === 'createRow' ||
			change.kind === 'changeRow' ||
			change.kind === 'mkdir')
	);
}

/**
 * Why a note's row editor did not open. Text that does not read as a note
 * opens all the same; these are the files with no text to edit.
 */
function openProblem(error: TableEditError | ThrownError): string {
	switch (error.name) {
		case 'NotFound':
			return 'This file is no longer in the folder.';
		case 'InvalidUtf8':
			return 'This note is not UTF-8 text, so it cannot be opened here. Rename, delete, and the terminal still work on it.';
		case 'Aborted':
			return 'Opening this note was stopped.';
		default:
			return error.message;
	}
}

type ThrownError = { readonly name: 'Thrown'; readonly message: string };

/** Acquire a note's row editor. Storage that throws is an error, not a rejection. */
async function acquire(
	edit: NotesHost['folder']['tables']['notes']['edit'],
	stem: string,
	signal?: AbortSignal,
) {
	try {
		return await edit(stem, { signal });
	} catch (cause) {
		return {
			data: null,
			error: {
				name: 'Thrown',
				message: cause instanceof Error ? cause.message : String(cause),
			} satisfies ThrownError,
		} as const;
	}
}

/**
 * A field change's refusal in words a person can act on. A conflict and a
 * reply that never came keep their names, so `ask` reads them as before.
 */
function updateError(error: TableUpdateError): {
	readonly name: string;
	readonly message: string;
} {
	switch (error.name) {
		case 'NotFound':
			return {
				name: error.name,
				message: 'This file is no longer in the folder.',
			};
		case 'Unparsed':
			return {
				name: error.name,
				message: `This file needs repair before it can be changed here (${error.error.message}). Open it to repair it as text.`,
			};
		case 'UnsupportedSource':
			return {
				name: error.name,
				message: `This change would rewrite other text in the file (${error.reason}). Open it to change it as text.`,
			};
		default:
			return error;
	}
}

/** Why a save that was asked for did not end saved, or undefined when it did. */
function saveProblem(session: FileSession): string | undefined {
	switch (session.status) {
		case 'failed':
			return session.failure;
		case 'conflict':
			return 'The file changed elsewhere. Open it to choose which version to keep.';
		case 'unconfirmed':
			return session.pathChange !== undefined
				? 'A rename or delete of this file was not confirmed. Open it to see where it stands.'
				: 'The save was not confirmed, so it may or may not be in the file. Open it to save again or keep the file.';
		default:
			return undefined;
	}
}

export function createNotes(host: NotesHost) {
	const { folder } = host;

	let notes = $state.raw<NoteEntry[]>([]);
	let folders = $state.raw<FolderEntry[]>([]);
	let unreadable = $state.raw<{ path: string; message: string }[]>([]);
	let unreadableFolders = $state.raw<{ path: string; message: string }[]>([]);
	let listError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	let git = $state.raw<GitSnapshot>(folder.git.snapshot);
	let selectedPath = $state<string | undefined>();
	/** Bumped when a note is selected, so its editor takes focus. */
	let focusRequest = $state(0);
	/** Set while a close is being answered: no input and no action is taken. */
	let fenced = $state(false);
	/** Set once `close` begins. Nothing opens after it, and the fence stays. */
	let closing: Promise<void> | undefined;
	/** Row editors being opened, so `close` can abandon them. */
	const opening = new Set<AbortController>();
	let pending = $state.raw<PendingChange[]>([]);
	/** Pending changes whose result the folder showed at the last refresh. */
	let found = $state.raw<ReadonlySet<PendingChange>>(new Set());
	/** Literal paths reserved before a mutation starts preparing or publishing. */
	const working = new SvelteMap<Promise<unknown>, readonly string[]>();
	/** Which notes the list shows. */
	let view = $state<{
		folderId: string | null;
		deleted: boolean;
		query: string;
	}>({ folderId: null, deleted: false, query: '' });
	let refreshing: Promise<void> | undefined;
	let refreshAgain = false;

	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([NOTES]);
	const openFiles = new SvelteMap<string, OpenFile>();
	const notePaths = $derived(new Set(notes.map((entry) => entry.path)));

	/**
	 * Every run reads the same signals whatever is selected: the open-file
	 * collection whole and the path. Svelte re-runs a derived with the
	 * values from before an update while an effect that read it is torn down,
	 * and keeps that run's dependencies. A lookup by the selected key alone
	 * would leave this subscribed to the path just left, so a file that
	 * finishes loading afterwards would never show. Reading the lookup straight
	 * from the accessor does not avoid it: a view's `{@const}` over the
	 * selection is a derived too, and inherits the same keyed dependencies.
	 */
	const selection = $derived.by((): Selection | undefined => {
		const files = new Map(openFiles);
		const path = selectedPath;
		if (path === undefined) return undefined;
		const file = files.get(path);
		if (file?.kind === 'note')
			return { kind: 'note', session: file.session, key: file.key };
		return file && { kind: 'file', path, file };
	});

	const terminal = createTerminalSession(
		host.terminal,
		refreshAll,
		() => !fenced,
	);
	const unsubscribeGit = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	// A hint says to read again; it is never used as what was read. The
	// folder hints this page's own saves too, so a note's write reaches the
	// list this way. Hints that arrive during a refresh share its next pass.
	const unsubscribeChanges = folder.onFilesChanged(() => void refresh());

	/** The raw session for an opened text file. */
	function sessionAt(path: string): FileSession | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'text' ? file.session : undefined;
	}

	/** The session for an opened note. */
	function noteAt(path: string): NoteSession | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'note' ? file.session : undefined;
	}

	function allSessions(): FileSession[] {
		return [...openFiles.values()].flatMap((file) =>
			file.kind === 'text' ? [file.session] : [],
		);
	}

	function allNotes(): NoteSession[] {
		return [...openFiles.values()].flatMap((file) =>
			file.kind === 'note' ? [file.session] : [],
		);
	}

	/** Every open session's status, raw files and notes alike. */
	const statuses = () => [
		...allSessions().map((session) => session.status),
		...allNotes().map((session) => session.status),
	];

	const unaccounted = () =>
		[...allSessions(), ...allNotes()].filter((session) => session.unsettled)
			.length +
		[...openFiles.values()].filter((file) => file.kind === 'unopened').length +
		pending.length +
		working.size;

	/** A path owns one raw session, begun from what was read or written there. */
	function sessionFor(initial: Capture): FileSession {
		const existing = sessionAt(initial.path);
		if (existing !== undefined) return existing;
		const session = createFileSession(folder.files, initial, {
			onSaved() {
				rehome(session);
				void refresh();
			},
			admits: () => !fenced,
		});
		openFiles.set(initial.path, { kind: 'text', session });
		return session;
	}

	/** A note session over an editor the caller opened. The caller keeps it under its path. */
	function noteSession(
		editor: NoteEditor,
		path: string,
		rawMode = false,
	): NoteSession {
		return createNoteSession(editor, {
			path,
			rawMode,
			admits: () => !fenced,
		});
	}

	/**
	 * Open a note whose text the person just saved as a new file at `at`, in
	 * place of the session `from` held. The old session is let go only once
	 * the text is safe either way: in an editor that read the new file, or in
	 * an `unopened` entry that keeps it exactly. Nothing is installed after
	 * the page began closing; the text is in the file then. The caller holds
	 * the note's input fence and both paths' reservation throughout. An owner
	 * already kept at `at` stays; it holds the file the text was saved in.
	 */
	async function handOff(
		from: { path: string; file: Extract<OpenFile, { kind: 'note' }> },
		at: string,
		text: string,
	): Promise<string | undefined> {
		const stem = noteIdOf(at);
		if (stem === undefined || closing !== undefined) return undefined;
		const { session, key } = from.file;
		const rawMode = session.rawMode;
		const { data: editor, error } = await acquire(
			folder.tables.notes.edit,
			stem,
		);
		if (closing !== undefined || openFiles.get(from.path) !== from.file)
			return undefined;
		session.release();
		openFiles.delete(from.path);
		if (selectedPath === from.path) selectedPath = at;
		const occupant = openFiles.get(at);
		if (
			occupant?.kind === 'note' ||
			occupant?.kind === 'text' ||
			occupant?.kind === 'unopened'
		)
			return undefined;
		if (error === null) {
			openFiles.set(at, {
				kind: 'note',
				session: noteSession(editor, at, rawMode),
				key,
			});
			return undefined;
		}
		const message = `Your text was saved as "${basename(at)}", and that file could not be opened: ${openProblem(error)}`;
		openFiles.set(at, { kind: 'unopened', text, message, key });
		return message;
	}

	/** A raw session that was saved or moved to another path is kept under that path. */
	function rehome(session: FileSession) {
		for (const [path, file] of openFiles)
			if (file.kind === 'text' && file.session === session)
				return follow(path, session.path);
	}

	/** Stop keeping an opened file. Its session saves nothing more. */
	function forget(path: string) {
		const file = openFiles.get(path);
		if (file?.kind === 'text') file.session.dispose();
		else if (file?.kind === 'note') file.session.release();
		openFiles.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/** Keep an opened file, and the selection, under the path it now has. */
	function follow(from: string, to: string) {
		const file = openFiles.get(from);
		if (file === undefined || from === to) return;
		openFiles.delete(from);
		openFiles.set(to, file);
		if (selectedPath === from) selectedPath = to;
	}

	/** A path has one mutation owner, including while its reply is still pending. */
	function pathProblem(...paths: string[]): string | undefined {
		if (
			[...working.values()].some((names) =>
				names.some((path) => paths.includes(path)),
			)
		)
			return 'A change to this file is still running. Wait for it to finish before editing or changing it.';
		const change = pending.find((item) =>
			pathsOf(item).some((path) => paths.includes(path)),
		);
		if (change !== undefined)
			return `An earlier change was not confirmed (${change.label}), so nothing else is changed there until it is. See the status menu.`;
		const owner =
			allSessions().some(
				(session) =>
					session.pathChange?.kind === 'move' &&
					paths.includes(session.pathChange.to),
			) ||
			allNotes().some(
				(session) =>
					session.pathChange?.kind === 'move' &&
					paths.includes(session.pathChange.to),
			);
		return owner
			? 'This file belongs to an open draft with an unfinished change. Resolve that draft before editing here.'
			: undefined;
	}

	/** Reads may look during close; changing calls also respect its input fence. */
	function held(...paths: string[]): string | undefined {
		return fenced ? CLOSING : pathProblem(...paths);
	}

	/** Reserve the affected paths before any asynchronous preparation starts. */
	function reserve<T>(
		paths: readonly string[],
		run: () => Promise<T>,
	): Promise<T> {
		const running = Promise.resolve()
			.then(run)
			.finally(() => working.delete(running));
		working.set(running, paths);
		return running;
	}

	/** Publish an unopened file's change and retain ambiguity before close can count it. */
	function send<T>(
		paths: readonly string[],
		run: () => Promise<FileOutcome<T>>,
		record: (outcome: FileOutcome<T>) => void,
	): Promise<FileOutcome<T>> {
		return reserve(paths, async () => {
			// A close can begin during preparation, before this publication turn.
			if (fenced) return { kind: 'failed', name: 'Closing', message: CLOSING };
			const outcome = await run();
			record(outcome);
			return outcome;
		});
	}

	/** Keep `change` as it was sent when its outcome is unknown, or when a move kept its source. */
	const keep =
		(change: SentChange & { label: string }) =>
		(outcome: FileOutcome<unknown>) => {
			if (outcome.kind === 'unconfirmed' || outcome.kind === 'sourceNotRemoved')
				pending = [
					...pending,
					// History: nothing changes a record once it is kept.
					Object.freeze({
						...change,
						state: outcome.kind,
						problem: outcome.message,
					}),
				];
		};

	/** What to tell the person about the reply to `change`. */
	function replyTo(
		outcome: FileOutcome<unknown>,
		change: SentChange,
	): string | undefined {
		if (outcome.kind === 'failed' && outcome.name === 'DirectoryNotEmpty')
			return 'The folder is not empty, so nothing was deleted.';
		return problemOf(outcome);
	}

	/**
	 * Assign fields in the current text of a row that has no open session.
	 * Every other byte stays: other fields, valid or not, unknown keys,
	 * comments, quoting, and the body. The table publishes once, only over
	 * the bytes it read, and under the change's own condition. It publishes
	 * even when the fields already hold those values.
	 */
	function changeRow(
		change: Extract<SentChange, { kind: 'changeRow' }>,
	): Promise<FileOutcome<unknown>> {
		const { stem, options } = change;
		return ask(async () => {
			const updated =
				change.table === 'notes'
					? await folder.tables.notes.update(
							stem,
							{ fields: change.fields as Partial<NoteFields> },
							options,
						)
					: await folder.tables.folders.update(
							stem,
							{ fields: change.fields as Partial<FolderFields> },
							options,
						);
			return updated.error === null ? updated : Err(updateError(updated.error));
		});
	}

	function createRowFile(
		change: Extract<SentChange, { kind: 'createRow' }>,
	): Promise<FileOutcome<unknown>> {
		const { stem } = change;
		return change.table === 'notes'
			? ask(() =>
					folder.tables.notes.create({
						stem,
						fields: change.fields as NoteFields,
					}),
				)
			: ask(() =>
					folder.tables.folders.create({
						stem,
						fields: change.fields as FolderFields,
					}),
				);
	}

	/**
	 * Whether the listed row at `path` holds every value in `fields`. A string
	 * is compared as the text of its bytes: encoding replaces an unpaired
	 * surrogate, so the file can never hold the string that was asked for.
	 */
	function rowHolds(path: string, fields: object): boolean {
		const row = [...notes, ...folders].find((entry) => entry.path === path);
		if (row === undefined) return false;
		const listed = row.fields as Readonly<Record<string, unknown>>;
		return Object.entries(fields).every(
			([key, value]) =>
				Object.hasOwn(listed, key) &&
				JSON.stringify(listed[key]) ===
					JSON.stringify(
						typeof value === 'string' ? submittedText(value).text : value,
					),
		);
	}

	/** The text a path holds in what was just listed, or what a read finds. */
	async function sourceAt(path: string): Promise<string | undefined> {
		const row = [...notes, ...folders].find((entry) => entry.path === path);
		if (row !== undefined) return row.text;
		if (!listing?.files.some((file) => file.path === path)) return undefined;
		const read = await readTextFile(folder.files, path).catch(() => undefined);
		return read?.data?.kind === 'text' ? read.data.file.text : undefined;
	}

	/**
	 * Note which pending changes the folder now shows the result of: a new
	 * file's exact text, a row's fields by value, a directory. That is what
	 * the folder holds, not that the change arrived, so nothing is dropped:
	 * the record stays until the person dismisses it or asks again. A move, a
	 * removal, and a removed directory have no result to find.
	 */
	async function observePending() {
		const next = new Set<PendingChange>();
		for (const change of pending) {
			const reached =
				change.kind === 'create'
					? (await sourceAt(change.path)) === change.source
					: change.kind === 'createRow' || change.kind === 'changeRow'
						? rowHolds(change.path, change.fields)
						: change.kind === 'mkdir'
							? (listing?.directories.includes(change.path) ?? false)
							: false;
			if (closing !== undefined) return;
			if (reached) next.add(change);
		}
		found = next;
	}

	async function refreshOnce() {
		if (closing !== undefined) return;
		const opened = [...openFiles].map(([path, file]) => ({
			path,
			file,
			saved: file.kind === 'text' ? file.session.saved : undefined,
		}));
		let rows: Awaited<ReturnType<typeof folder.tables.notes.list>>;
		let folderRows: Awaited<ReturnType<typeof folder.tables.folders.list>>;
		let files: Awaited<ReturnType<typeof folder.files.list>>;
		try {
			[rows, folderRows, files] = await Promise.all([
				folder.tables.notes.list(),
				folder.tables.folders.list(),
				folder.files.list(),
			]);
		} catch (cause) {
			// The folder could not be reached. Keep what is on screen.
			if (closing !== undefined) return;
			listError = cause instanceof Error ? cause.message : String(cause);
			return;
		}
		if (closing !== undefined) return;
		const { data: rowEntries, error: rowsError } = rows;
		const { data: folderEntries, error: foldersError } = folderRows;
		const { data: fileEntries, error: filesError } = files;
		if (rowsError) {
			// Never show an empty list for a failed read.
			listError = rowsError.message;
		} else {
			listError = undefined;
			// A file that was read is a note to select, whether or not its text
			// parses. A file that could not be read has no text to open.
			notes = rowEntries.flatMap(({ result: { data } }) => data ?? []);
			unreadable = rowEntries.flatMap(({ path, result: { error } }) =>
				error ? { path, message: error.message } : [],
			);
		}
		if (!foldersError) {
			folders = folderEntries.flatMap(({ result: { data } }) => data ?? []);
			unreadableFolders = folderEntries.flatMap(
				({ path, result: { error } }) =>
					error ? { path, message: error.message } : [],
			);
		}
		if (filesError) {
			listingError = filesError.message;
		} else {
			listingError = undefined;
			listing = fileEntries;
		}
		if (!rowsError && !foldersError && !filesError) await observePending();
		const paths = new Set(fileEntries?.files.map((file) => file.path));
		for (const { path, file, saved } of opened) {
			if (closing !== undefined) return;
			if (openFiles.get(path) !== file) continue;
			// Text kept for the person stays whatever a listing shows. An open
			// note keeps its editor's text until the person reloads it.
			if (
				file.kind === 'loading' ||
				file.kind === 'unopened' ||
				file.kind === 'note'
			)
				continue;
			if (file.kind !== 'text') {
				if (!filesError && !paths.has(path)) openFiles.delete(path);
				continue;
			}
			// A save, a rename, or an adopted file since the listing began makes
			// the listing older than what the session holds.
			if (file.session.saved !== saved || filesError) continue;
			const outcome = paths.has(path)
				? await file.session.reread()
				: file.session.observe({ kind: 'removed' });
			// The path may have been renamed or explicitly discarded during the read.
			if (closing !== undefined) return;
			if (outcome === 'gone' && openFiles.get(path) === file) forget(path);
		}
	}

	/** One refresh at a time; a request during one runs once more afterwards. */
	function refresh(): Promise<void> {
		if (closing !== undefined) return Promise.resolve();
		if (refreshing !== undefined) {
			refreshAgain = true;
			return refreshing;
		}
		refreshing = (async () => {
			try {
				do {
					refreshAgain = false;
					await Promise.all([
						refreshOnce(),
						folder.git.status().catch(() => undefined),
					]);
				} while (refreshAgain && closing === undefined);
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	}

	function refreshAll() {
		return refresh();
	}

	/**
	 * Select a file without replacing any session already kept for its path.
	 * A note opens its row editor, whether or not its text reads as a note;
	 * a note file with no text to edit shows why. Any other text file opens
	 * as text.
	 */
	async function open(path: string) {
		// A closing page opens nothing more.
		if (closing !== undefined) return;
		selectedPath = path;
		focusRequest += 1;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const known = openFiles.get(path);
		if (
			known?.kind === 'text' ||
			known?.kind === 'note' ||
			known?.kind === 'loading' ||
			known?.kind === 'unopened'
		)
			return;
		// A file with a change outstanding gets no editor: a save from one could
		// land on the wrong side of that change.
		const blocked = pathProblem(path);
		if (blocked !== undefined) {
			openFiles.set(path, { kind: 'failed', message: blocked });
			return;
		}
		// Identity, rather than the loading tag, keeps an old read from replacing
		// a newer open after rename, deletion, or an explicit discard.
		const loading: OpenFile = { kind: 'loading' };
		openFiles.set(path, loading);
		const stem = noteIdOf(path);
		if (stem !== undefined) {
			const controller = new AbortController();
			opening.add(controller);
			const { data: editor, error: editError } = await acquire(
				folder.tables.notes.edit,
				stem,
				controller.signal,
			).finally(() => opening.delete(controller));
			// An editor that opened anyway after the page began closing, or after
			// the path was taken over, is not kept. Nothing subscribed to it.
			if (closing !== undefined) {
				if (openFiles.get(path) === loading) openFiles.delete(path);
				return;
			}
			if (openFiles.get(path) !== loading) return;
			const blockedNow = pathProblem(path);
			if (blockedNow !== undefined)
				openFiles.set(path, { kind: 'failed', message: blockedNow });
			else if (editError === null)
				openFiles.set(path, {
					kind: 'note',
					session: noteSession(editor, path),
					key: {},
				});
			// A recognized note is never handed to a text session: its file has
			// one editor, and there is no text here to edit.
			else
				openFiles.set(path, {
					kind: 'failed',
					message: openProblem(editError),
				});
			return;
		}
		const { data: read, error: readError } = await readTextFile(
			folder.files,
			path,
		).catch((cause: unknown) => ({
			data: null,
			error: {
				name: 'Thrown',
				message: cause instanceof Error ? cause.message : String(cause),
			},
		}));
		if (closing !== undefined) {
			if (openFiles.get(path) === loading) openFiles.delete(path);
			return;
		}
		if (openFiles.get(path) !== loading) return;
		const nowBlocked = pathProblem(path);
		if (nowBlocked !== undefined) {
			openFiles.set(path, { kind: 'failed', message: nowBlocked });
			return;
		}
		if (readError)
			openFiles.set(path, {
				kind: 'failed',
				message:
					readError.name === 'NotFound'
						? 'This file is no longer in the folder.'
						: readError.message,
			});
		else if (read.kind === 'text') {
			openFiles.delete(path);
			sessionFor(read.file);
		} else openFiles.set(path, read);
	}

	/**
	 * Why an action from a list may not change an open note now, before it
	 * touches the editor. The change goes into the editor's whole document,
	 * so a failed save does not block it. A rename or delete that is running
	 * or stopped short still blocks changes to the old path. `listed` is the
	 * text the values were derived from.
	 */
	function noteActionProblem(
		session: NoteSession,
		listed?: Capture,
	): string | undefined {
		if (session.busy)
			return 'A rename or delete of this note is still running. Try again when it finishes.';
		const { row } = session.get();
		if (session.hold !== undefined || session.pathChange !== undefined)
			return 'This note has a change that is not settled. Choose what to do in the note first.';
		if (session.rawMode)
			return 'This note is open as a file. Open it as a note to change it here.';
		if (row.status !== 'valid')
			return 'This note has a field that needs fixing. Fix it in the note first.';
		if (listed !== undefined && row.text !== listed.text)
			return 'The open note does not hold the text that was listed, so nothing was changed. Check it and try again.';
		return undefined;
	}

	/**
	 * Change a row's fields. An open note takes the change in its editor, so
	 * it joins whatever is being typed instead of racing it, as one whole
	 * document; its save replaces the file unconditionally. A row with no
	 * session has the fields assigned in its current text, once
	 * (`changeRow`).
	 *
	 * `listed` is the snapshot the values were derived from. A row with no
	 * session is then changed only while it holds those bytes; an open note
	 * only while its editor holds that text. Neither is rebased.
	 */
	async function changeFields(
		table: Table,
		path: string,
		fields: Partial<NoteFields> | Partial<FolderFields>,
		{ listed }: { listed?: Capture } = {},
	): Promise<string | undefined> {
		// Owned before anything waits: what is sent, kept pending, and sent
		// again is what was asked for now, whatever the caller's object becomes.
		const owned = Object.freeze({ ...fields });
		const blocked = held(path);
		if (blocked !== undefined) return blocked;
		const session = noteAt(path);
		if (session !== undefined) {
			const problem =
				noteActionProblem(session, listed) ??
				session.edit({ fields: owned as Partial<NoteFields> });
			if (problem !== undefined) return problem;
			const { error } = await session.waitForSaves();
			return error === null ? undefined : noteSaveProblem(error);
		}
		const stem = rowStemOf(table, path);
		if (stem === undefined) return 'This file is not a row of its table.';
		const change = {
			kind: 'changeRow',
			table,
			path,
			stem,
			fields: owned,
			options: Object.freeze(
				listed === undefined ? {} : { expectedSha256: listed.sha256 },
			),
			label: `Change to "${basename(path)}"`,
		} as const;
		const outcome = await send(
			pathsOf(change),
			() => changeRow(change),
			keep(change),
		);
		await refresh();
		return replyTo(outcome, change);
	}

	/** Create a row through its table; the path must not exist yet. */
	async function createRow(
		table: Table,
		fields: NoteFields | FolderFields,
		label: string,
	): Promise<Result<string, string>> {
		const stem = newId();
		const path = rowPath(table, stem);
		const change = {
			kind: 'createRow',
			table,
			path,
			stem,
			fields: Object.freeze({ ...fields }),
			label,
		} as const;
		const created = await send(
			pathsOf(change),
			() => createRowFile(change),
			keep(change),
		);
		if (created.kind === 'done') return Ok(path);
		return Err(replyTo(created, change) ?? created.kind);
	}

	/**
	 * Settle an open note before its file moves or goes, and capture the file
	 * as it is now. Run inside `session.operate`, so nothing is typed
	 * meanwhile. Every write already admitted settles first; the capture is
	 * read after that. It is refused when the file holds other text than the
	 * editor, so a rename or delete never acts on text the person has not
	 * seen. The editor keeps its text; the person reloads to see the file.
	 */
	async function captureNote(
		session: NoteSession,
	): Promise<Result<Capture, string>> {
		const { error: saveError } = await session.waitForSaves();
		if (saveError !== null || session.unsettled) return Err(UNSETTLED);
		const { data: read, error: readError } = await readTextFile(
			folder.files,
			session.path,
		).catch((cause: unknown) => ({
			data: null,
			error: {
				name: 'Thrown',
				message: cause instanceof Error ? cause.message : String(cause),
			},
		}));
		if (readError)
			return Err(
				readError.name === 'NotFound'
					? 'This file is no longer in the folder.'
					: readError.message,
			);
		if (read.kind !== 'text' || session.get().row.text !== read.file.text)
			return Err(NOTE_CHANGED);
		return Ok(read.file);
	}

	/**
	 * Rename an open note. Its editor is fixed to its path, so the note is
	 * settled and its input fenced first, and the move names the file as it
	 * was captured after that. Once the move is confirmed an editor opened at
	 * the new path takes the note's place, and the old one is released.
	 * Nothing is written to either path meanwhile. The fence goes up in the
	 * same turn as the call, before the reservation's work begins, so no input
	 * slips in between.
	 */
	function renameNote(
		session: NoteSession,
		path: string,
		to: string,
	): Promise<FileOutcome<unknown> | { readonly kind: 'unsettled' }> {
		const stem = noteIdOf(to);
		return session.operate(() =>
			reserve([path, to], async () => {
				const { data: captured, error: captureError } =
					await captureNote(session);
				if (captureError !== null)
					return captureError === UNSETTLED
						? ({ kind: 'unsettled' } as const)
						: ({
								kind: 'failed',
								name: 'Changed',
								message: captureError,
							} as const);
				const step = {
					kind: 'move',
					from: { path, sha256: captured.sha256 },
					to,
				} as const;
				session.track(step);
				const moved = await moveFile(folder.files, step.from, to);
				session.conclude(step, moved);
				if (moved.kind !== 'done' || stem === undefined) return moved;
				const { data: editor, error: editError } = await acquire(
					folder.tables.notes.edit,
					stem,
				);
				const file = openFiles.get(path);
				session.release();
				if (file?.kind !== 'note' || file.session !== session) return moved;
				openFiles.delete(path);
				openFiles.set(
					to,
					editError === null
						? {
								kind: 'note',
								session: noteSession(editor, to, session.rawMode),
								key: file.key,
							}
						: {
								kind: 'failed',
								message: `This note was renamed to "${basename(to)}" and could not be opened there: ${openProblem(editError)}`,
							},
				);
				if (selectedPath === path) selectedPath = to;
				return moved;
			}),
		);
	}

	/**
	 * Save the exact text a note's editor holds as a new file, after its last
	 * save or reload found no file, and only while no typed value the editor
	 * refused is waiting in a field: at its own path while that is free, else
	 * as a new note. The row editor never creates a file, so each is an
	 * exclusive create that refuses when anything is there, and a file found
	 * there stays as it is. A first create that finds its own path taken goes
	 * on to a new note; one whose reply was lost goes nowhere else, and no
	 * second copy of that text is created while it is pending. Once a create
	 * is confirmed, the note opens over the new file (`handOff`); the
	 * person's text stays on screen until that is safe.
	 *
	 * One operation owns all of it, from this call to the handoff: the note's
	 * input is fenced in this turn, so nothing typed meanwhile can be dropped
	 * by the release, and its path and the new note's path, chosen now, are
	 * reserved before anything is awaited, so no second recovery, open, or
	 * change reaches either until the handoff is done. A close waits for it.
	 */
	async function recreateNote(
		path: string,
		file: Extract<OpenFile, { kind: 'note' }>,
	): Promise<string | undefined> {
		const { session } = file;
		if (!session.missing)
			return 'This note’s file was there when it was last saved or read. Save over it instead.';
		// The handoff releases this session, and with it typing the editor
		// refused; the new file would hold only the text before it.
		if (Object.keys(session.refused).length > 0)
			return 'Something you typed in this note is not saved yet: a file cannot hold one of its characters. Fix it where you typed it, then save the note as a file.';
		const { row, save } = session.get();
		if (session.busy || save.status === 'saving')
			return 'A save, rename, or delete of this note is still running. Try again when it finishes.';
		const { text } = row;
		// Encoding would replace the character, and the file would not hold
		// what the person wrote. The text stays on screen to fix or copy.
		if (!text.isWellFormed())
			return 'Your text has a character a file cannot hold exactly (an unpaired surrogate), so no file was made. Fix it or copy your text first.';
		if (pending.some((item) => item.kind === 'create' && item.source === text))
			return 'An earlier save of this text was not confirmed, so it is not saved again elsewhere. See the status menu.';
		const name = basename(path);
		const create = (at: string, label: string) => {
			const change = { kind: 'create', path: at, source: text, label } as const;
			return send(
				pathsOf(change),
				() => createFile(folder.files, at, text),
				keep(change),
			).then((outcome) => ({ at, change, outcome }));
		};
		const elsewhere = notePath(newId());
		return session.operate(() =>
			reserve([path, elsewhere], async () => {
				let created = await create(path, `Save "${name}" again`);
				if (
					created.outcome.kind === 'refused' &&
					created.outcome.occupied === path
				)
					created = await create(elsewhere, `Save "${name}" as a new note`);
				if (created.outcome.kind !== 'done')
					return replyTo(created.outcome, created.change);
				return handOff({ path, file }, created.at, text);
			}),
		);
	}

	/** Up to three file names, for a message. */
	function named(items: readonly { path: string }[]): string {
		const names = items.slice(0, 3).map((item) => basename(item.path));
		if (items.length > names.length) names.push('and more');
		return names.join(', ');
	}

	/** Whether a pending change could put a note in folder `id`, as far as is known. */
	function mayFile(change: PendingChange, id: string): boolean {
		switch (change.kind) {
			case 'createRow':
			case 'changeRow':
				return (
					change.table === 'notes' &&
					(change.fields as Partial<NoteFields>).folderId === id
				);
			case 'create': {
				if (noteIdOf(change.path) === undefined) return false;
				const { fields } = inspectRow(
					honeycrispDefinition.tables.notes,
					change.source,
				);
				return !Object.hasOwn(fields, 'folderId') || fields.folderId === id;
			}
			case 'move':
				// What it moved is not known from here.
				return noteIdOf(change.to) !== undefined;
			default:
				return false;
		}
	}

	/**
	 * Why an open note stops folder `id` from being deleted, or undefined.
	 * One whose editor and listed file both leave the folder alone does not,
	 * nor one whose editor holds exactly the listed text with nothing
	 * outstanding; it is moved out through its editor.
	 */
	function openNoteProblem(
		path: string,
		session: NoteSession,
		id: string,
	): string | undefined {
		const name = basename(path);
		const { row } = session.get();
		const fields =
			row.status === 'valid'
				? row.fields
				: inspectRow(honeycrispDefinition.tables.notes, row.text).fields;
		if (!Object.hasOwn(fields, 'folderId'))
			return `The folder in the open note "${name}" cannot be read. Fix it in the note first.`;
		const listed = notes.find((note) => note.path === path);
		const openIn = fields.folderId === id;
		const fileIn = listed?.fields.folderId === id;
		if (!openIn && !fileIn) return undefined;
		const problem = noteActionProblem(session);
		if (problem !== undefined) return `"${name}": ${problem}`;
		if (listed === undefined || row.text !== listed.text)
			return `The open note "${name}" holds text that is not in its file as listed. Let it save, or reload it, and try again.`;
		return undefined;
	}

	/**
	 * Why the notes in folder `id` cannot all be found and moved out now, or
	 * undefined. It looks at what this page knows: the last listing, open
	 * notes and files, and changes still running or not confirmed. Another
	 * program can still put a note in the folder after that.
	 */
	function folderDeletionProblem(id: string): string | undefined {
		if (listError !== undefined)
			return `The notes could not be listed, so it is not known which are in this folder: ${listError}`;
		const unknown = [
			...notes.filter((note) => !Object.hasOwn(note.fields, 'folderId')),
			...unreadable,
		];
		if (unknown.length > 0)
			return `Some notes cannot be read well enough to tell which folder they are in (${named(unknown)}). Repair or remove them first, so no note is left pointing at a folder that is gone.`;
		const members = notes.filter((item) => item.fields.folderId === id);
		// A change still running may put a note anywhere.
		const running = [...working.values()]
			.flat()
			.filter((path) => noteIdOf(path) !== undefined);
		if (running.length > 0)
			return `A change to a note is still running (${named(running.map((path) => ({ path })))}). Wait for it to finish first.`;
		const unconfirmed = pending.find((change) => mayFile(change, id));
		if (unconfirmed !== undefined)
			return `An earlier change that may put a note in this folder was not confirmed (${unconfirmed.label}). Dismiss it or send it again from the status menu first.`;
		const stuck = members.filter(
			(note) => pathProblem(note.path) !== undefined,
		);
		if (stuck.length > 0)
			return `Some notes in this folder have a change that is not confirmed (${named(stuck)}). See the status menu.`;
		for (const [path, file] of openFiles) {
			if (file.kind !== 'note') continue;
			const problem = openNoteProblem(path, file.session, id);
			if (problem !== undefined) return problem;
		}
		return undefined;
	}

	return {
		host,
		terminal,
		get notes() {
			return notes;
		},
		get folders() {
			return folders;
		},
		/** Note and folder files whose bytes could not be read as text. */
		get unreadable() {
			return [...unreadable, ...unreadableFolders];
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
		get view() {
			return view;
		},
		showFolder(folderId: string | null) {
			view = { ...view, folderId, deleted: false };
		},
		showDeleted() {
			view = { ...view, folderId: null, deleted: true };
		},
		setQuery(query: string) {
			view = { ...view, query };
		},
		get selectedPath() {
			return selectedPath;
		},
		get selection() {
			return selection;
		},
		get focusRequest() {
			return focusRequest;
		},
		isNote(path: string) {
			return notePaths.has(path);
		},
		/** The one raw session for a file opened as text. */
		sessionAt,
		/** The one session for an opened note. */
		noteAt,
		/**
		 * What leaving now would lose or stop tracking: drafts with typing, an
		 * open change, or a conflict, and changes to files with no editor that
		 * are still being sent or were never confirmed.
		 */
		get unsettled() {
			return unaccounted();
		},
		get saving() {
			return working.size > 0 || statuses().includes('saving');
		},
		/** Sessions whose text is known not to be in its file. */
		get notSaved() {
			return statuses().filter(
				(status) => status === 'failed' || status === 'conflict',
			).length;
		},
		/**
		 * Changes that may or may not have happened: open files whose save,
		 * rename, or delete was not confirmed, and every pending change.
		 */
		get unconfirmed() {
			return (
				statuses().filter((status) => status === 'unconfirmed').length +
				pending.length
			);
		},
		/** Changes to files with no open session whose outcome is not known. */
		get pending() {
			return pending;
		},
		/**
		 * Whether the folder showed what `change` asked for at the last refresh.
		 * It says what the folder holds, never whether this change did it.
		 */
		found(change: PendingChange): boolean {
			return found.has(change);
		},
		/**
		 * Stop keeping a pending change, as the person chose. Its outcome stays
		 * unknown; this only stops holding its paths back.
		 */
		dismissPending(change: PendingChange) {
			if (fenced) return;
			pending = pending.filter((item) => item !== change);
		},
		/** Whether input and actions are held back while a close is answered. */
		get fenced() {
			return fenced;
		},
		/**
		 * Stop taking input and actions, before drafts are settled for a close.
		 * Returns the release, for a close that was declined or refused.
		 */
		fenceInput(): () => void {
			fenced = true;
			return () => {
				// A close keeps its fence for good.
				if (closing === undefined) fenced = false;
			};
		},
		refresh,
		refreshAll,
		open,
		/**
		 * Ask for a pending change again, as a new attempt. A new file and a new
		 * directory are asked for again; a new row is created again under the
		 * same name; a row's fields are assigned again under the same condition:
		 * on the row as it is now, or only while it holds the bytes the values
		 * were derived from. Only a confirmed reply ends the record. A refusal
		 * leaves it as it was: finding the result there does not say which
		 * attempt made it. A rename, a delete, and a removed directory cannot be
		 * sent again.
		 */
		async retryPending(change: PendingChange): Promise<string | undefined> {
			if (fenced) return CLOSING;
			if (!pending.includes(change)) return undefined;
			if (!canResend(change))
				return 'This cannot be sent again: whether it happened is not known, and a second one could act on a different file.';
			const outcome = await send<unknown>(
				pathsOf(change),
				() =>
					change.kind === 'create'
						? createFile(folder.files, change.path, change.source)
						: change.kind === 'createRow'
							? createRowFile(change)
							: change.kind === 'changeRow'
								? changeRow(change)
								: makeDirectory(folder.files, change.path),
				(reply) => {
					// The same record stands, or ends: a resend never adds a second.
					if (reply.kind === 'done')
						pending = pending.filter((item) => item !== change);
				},
			);
			await refresh();
			if (!pending.includes(change)) return undefined;
			return replyTo(outcome, change);
		},
		/** Create a note in the folder being shown and open it. */
		async createNote(): Promise<string | undefined> {
			if (fenced) return CLOSING;
			// A second note with a fresh name is not made while the first is unknown.
			if (pending.some((item) => item.label === NEW_NOTE))
				return 'An earlier new note was not confirmed. Send it again or dismiss it from the status menu before making another.';
			const at = now();
			const { data: created, error: createdError } = await createRow(
				'notes',
				{
					folderId: view.deleted ? null : view.folderId,
					title: '',
					pinned: false,
					createdAt: at,
					updatedAt: at,
					deletedAt: null,
				},
				NEW_NOTE,
			);
			if (createdError !== null) return createdError;
			await refresh();
			await open(created);
			return undefined;
		},
		/** Change a note's fields from the list: in its editor when it is open, else in its text. */
		patchNote: (path: string, fields: Partial<NoteFields>) =>
			changeFields('notes', path, fields),
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) =>
			changeFields('notes', path, { deletedAt: now() }),
		restoreNote: (path: string) =>
			changeFields('notes', path, { deletedAt: null }),
		async createFolder(name: string): Promise<string | undefined> {
			if (fenced) return CLOSING;
			const label = `New folder "${name}"`;
			if (pending.some((item) => item.label === label))
				return 'This folder was already asked for and not confirmed. Send it again or dismiss it from the status menu.';
			const { error: createdError } = await createRow(
				'folders',
				{ name, icon: null },
				label,
			);
			await refresh();
			return createdError ?? undefined;
		},
		patchFolder: (entry: FolderEntry, fields: Partial<FolderFields>) =>
			changeFields('folders', entry.path, fields),
		/**
		 * Delete a folder after moving its notes out. A note that cannot be
		 * moved stops the operation before the folder goes, so it can be retried
		 * without leaving a note this page knows of pointing at a folder that no
		 * longer exists (see the limits below). The folder's file is removed only
		 * as it was listed when this was asked.
		 *
		 * The members are the notes this page knows of: what was last listed,
		 * the open notes' editors, and changes still running or not confirmed
		 * (`folderDeletionProblem`). Everything is checked before any note
		 * moves. Not knowing is not the same as no, so a note whose folder
		 * cannot be read stops it; a note's other fields do not matter. After
		 * the notes move, the folder is read again and checked the same way
		 * before its file goes.
		 *
		 * This is best effort, not one atomic step. A listed note is moved out
		 * only while it holds the bytes listed; an open note only while its
		 * editor holds the text listed, but that save is unconditional, so a
		 * write its editor has not read is replaced. Another program can still
		 * put a note in the folder after the last read.
		 */
		async deleteFolder(entry: FolderEntry): Promise<string | undefined> {
			const blocked = held(entry.path);
			if (blocked !== undefined) return blocked;
			// A folder's id is its literal file stem, whatever that name is.
			const id = entry.stem;
			const before = folderDeletionProblem(id);
			if (before !== undefined) return before;
			const members = notes.filter((item) => item.fields.folderId === id);
			for (const note of members) {
				const problem = await changeFields(
					'notes',
					note.path,
					{ folderId: null },
					{ listed: note },
				);
				if (problem !== undefined)
					return `A note could not be moved out of the folder: ${problem}`;
			}
			// What moved, and anything put in the folder meanwhile, as read now.
			await refresh();
			const after = folderDeletionProblem(id);
			if (after !== undefined) return after;
			const remaining = notes.filter((item) => item.fields.folderId === id);
			if (remaining.length > 0)
				return `Some notes were put in this folder while it was being deleted (${named(remaining)}). Delete it again to move them out.`;
			const from: FileCapture = { path: entry.path, sha256: entry.sha256 };
			const change = {
				kind: 'remove',
				from,
				label: `Delete folder "${folderLabel(entry)}"`,
			} as const;
			const session = sessionAt(entry.path);
			// An open file's session keeps an unknown outcome itself.
			const removed =
				session !== undefined
					? await session.remove(from)
					: await send(
							pathsOf(change),
							() => removeFile(folder.files, from),
							keep(change),
						);
			// Already gone is the outcome that was asked for.
			const gone = removed.kind === 'failed' && removed.name === 'NotFound';
			if (removed.kind !== 'done' && !gone) {
				await refresh();
				return removed.kind === 'unsettled'
					? UNSETTLED
					: replyTo(removed, change);
			}
			forget(entry.path);
			if (view.folderId === id) view = { ...view, folderId: null };
			await refresh();
			return undefined;
		},
		/**
		 * Text whose file was removed or, for a raw file, became unreadable:
		 * save it as a file again, at its own path and only while that path is
		 * free. Another file there stays that file's.
		 *
		 * A note's text, exactly as its editor holds it, is created as a new
		 * file, never written by its row editor, which does not create files;
		 * when its own path is taken it is created as a new note. Once that is
		 * confirmed the note opens again over the new file. A raw draft whose
		 * earlier save was not confirmed is not saved a second time: that same
		 * save is sent again to its same path.
		 */
		async recoverDraft(path: string): Promise<string | undefined> {
			const blocked = held(path);
			if (blocked !== undefined) return blocked;
			const note = openFiles.get(path);
			if (note?.kind === 'note') return recreateNote(path, note);
			const session = sessionAt(path);
			if (session === undefined) return 'There is no draft to save.';
			if (session.status === 'unconfirmed') await session.retry();
			else {
				const reviewed = session.external;
				// Nothing is missing: an earlier save turned out to be in the file.
				if (reviewed === undefined) return undefined;
				if (reviewed.kind === 'changed')
					return 'The file is in the folder. Compare it with your draft to choose.';
				await session.saveMine(reviewed);
			}
			// What this save came to, before the refresh below observes anything newer.
			const problem = saveProblem(session);
			await refresh();
			return problem;
		},
		/**
		 * Explicitly discard what the person has in an open text file, as they
		 * chose. Nothing is written: the file stays as it is. A note has no
		 * draft to discard; reloading it replaces its text with the file.
		 */
		async discardDraft(path: string): Promise<string | undefined> {
			if (fenced) return CLOSING;
			const file = openFiles.get(path);
			const session = file?.kind === 'text' ? file.session : undefined;
			// A draft with something still outstanding is not discarded from here.
			if (session?.attempt !== undefined || session?.pathChange !== undefined)
				return undefined;
			const external = session?.external;
			// A draft whose rename or delete the person stopped tracking is theirs
			// to discard, whatever is at its path now. Nothing is written.
			if (
				session?.detached !== undefined ||
				(external !== undefined && external.kind !== 'changed')
			)
				forget(path);
			return undefined;
		},
		/**
		 * Open again a note whose text was kept because its new file did not
		 * open. The text stays kept when it still does not.
		 */
		async reopen(path: string): Promise<string | undefined> {
			const kept = openFiles.get(path);
			const stem = noteIdOf(path);
			if (kept?.kind !== 'unopened' || stem === undefined) return undefined;
			if (closing !== undefined) return CLOSING;
			const { data: editor, error } = await acquire(
				folder.tables.notes.edit,
				stem,
			);
			if (closing !== undefined || openFiles.get(path) !== kept) return;
			if (error !== null) {
				const message = `Your text was saved as "${basename(path)}", and that file could not be opened: ${openProblem(error)}`;
				openFiles.set(path, { ...kept, message });
				return message;
			}
			openFiles.set(path, {
				kind: 'note',
				session: noteSession(editor, path),
				key: kept.key,
			});
			return undefined;
		},
		/** Stop keeping text whose new file did not open, as the person chose. */
		dismiss(path: string) {
			if (fenced || openFiles.get(path)?.kind !== 'unopened') return;
			forget(path);
		},
		/**
		 * Stop tracking a rename or delete of an open file that is not
		 * accounted for: one whose reply was lost, a move that kept its source,
		 * or a renamed note that could not be opened at its new name. Nothing is
		 * concluded about where the file is. The text stays, nothing is saved
		 * by itself, and both paths can be opened to see what is there.
		 */
		stopTracking(path: string): string | undefined {
			if (fenced) return CLOSING;
			const file = openFiles.get(path);
			const stopped =
				file?.kind === 'note'
					? file.session.detach()
					: file?.kind === 'text'
						? file.session.detach()
						: false;
			if (!stopped) return 'Nothing about this file is being tracked.';
			void refresh();
			return undefined;
		},
		/**
		 * Put a committed version of a note in its editor, which saves it: its
		 * fields that read as valid, and its body. Fields it lacks or holds
		 * invalid values for, and keys Honeycrisp does not declare, stay as the
		 * editor has them.
		 */
		useVersion(session: NoteSession, source: string): string | undefined {
			if (fenced) return CLOSING;
			const version = inspectRow(honeycrispDefinition.tables.notes, source);
			if (version.body === undefined)
				return `This version does not read as a note (${version.parseError?.message}). Use Edit as file to change the text by hand.`;
			return session.edit({ fields: version.fields, body: version.body });
		},
		/**
		 * Rename a file within its directory. An open file moves on the capture
		 * its session holds; any other moves on the capture read now. Either
		 * way the bytes that move are the ones named, and the new name must be
		 * free.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			if (fenced) return CLOSING;
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			const blocked = held(path, to);
			if (blocked !== undefined) return blocked;
			if (sessionAt(to) !== undefined || noteAt(to) !== undefined)
				return `A draft for "${name}" is still open. Save or discard it before renaming another file to this name.`;
			if (notePaths.has(path) && noteIdOf(to) === undefined)
				return 'A note file keeps its .md extension.';
			const note = noteAt(path);
			const session = sessionAt(path);
			if (note !== undefined || session !== undefined) {
				// The session keeps an unknown outcome, or a move that kept its source.
				const outcome =
					note !== undefined
						? await renameNote(note, path, to)
						: await reserve([path, to], () =>
								(session as FileSession).move(to),
							);
				// A text file renamed into a note is a note now: it has one editor,
				// its row editor. Its session settled before it moved.
				if (
					outcome.kind === 'done' &&
					session !== undefined &&
					noteIdOf(to) !== undefined &&
					sessionAt(to) === session
				) {
					const selected = selectedPath === to;
					forget(to);
					if (selected) await open(to);
				}
				await refreshAll();
				const landed = openFiles.get(to);
				if (outcome.kind === 'done' && landed?.kind === 'failed')
					return landed.message;
				return problemOf(outcome);
			}
			let reopen = false;
			const reply = await reserve([path, to], async () => {
				const { data: read, error: readError } = await folder.files.read(path);
				if (readError) return readError.message;
				const from: FileCapture = { path, sha256: read.sha256 };
				const change = {
					kind: 'move',
					from,
					to,
					label: `Rename "${basename(path)}" to "${name}"`,
				} as const;
				// A close may have begun during the read: `send` checks again.
				const outcome = await send(
					pathsOf(change),
					() => moveFile(folder.files, from, to),
					keep(change),
				);
				// A read still running belongs to the old path: open the new one.
				if (
					outcome.kind === 'done' &&
					(openFiles.get(path)?.kind === 'loading' ||
						openFiles.get(path)?.kind === 'failed')
				) {
					const selected = selectedPath === path;
					openFiles.delete(path);
					if (selected) {
						selectedPath = to;
						reopen = true;
					}
				} else if (outcome.kind === 'done') follow(path, to);
				await refreshAll();
				return replyTo(outcome, change);
			});
			if (reopen) await open(to);
			return reply;
		},
		/** A new empty text file; it never replaces an existing one. */
		async createFile(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			const blocked = held(path);
			if (blocked !== undefined) return blocked;
			if (listing?.directories.includes(path))
				return `"${name}" already exists here.`;
			const change = {
				kind: 'create',
				path,
				source: '',
				label: `New file "${name}"`,
			} as const;
			const created = await send(
				pathsOf(change),
				() => createFile(folder.files, path, ''),
				keep(change),
			);
			if (created.kind !== 'done') return replyTo(created, change);
			await refreshAll();
			await open(path);
			return undefined;
		},
		async createDirectory(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			const blocked = held(path);
			if (blocked !== undefined) return blocked;
			if (
				listing?.directories.includes(path) ||
				listing?.files.some((file) => file.path === path)
			)
				return `"${name}" already exists here.`;
			const change = {
				kind: 'mkdir',
				path,
				label: `New folder "${name}" in Files`,
			} as const;
			const made = await send(
				pathsOf(change),
				() => makeDirectory(folder.files, path),
				keep(change),
			);
			if (made.kind !== 'done') return replyTo(made, change);
			if (directory !== '') expanded.add(directory);
			await refresh();
			return undefined;
		},
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * An open file is captured after pending typing is saved: a raw file as
		 * its session holds it, a note as the file reads once its admitted
		 * writes settled, and only while that is the text its editor holds. A
		 * session that cannot settle refuses, so no deletion discards input.
		 * Only empty directories can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const blocked = held(path);
			if (blocked !== undefined) return Err(blocked);
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
			const note = noteAt(path);
			const session = sessionAt(path);
			let captured: FileCapture & { text: string | undefined };
			if (note !== undefined) {
				const { data: file, error: captureError } = await note.operate(() =>
					captureNote(note),
				);
				if (captureError !== null) return Err(captureError);
				captured = file;
			} else if (session !== undefined) {
				if (!(await session.settle())) return Err(UNSETTLED);
				captured = session.saved;
			} else {
				const listed = notes.find((entry) => entry.path === path);
				if (listed !== undefined) captured = listed;
				else {
					const { data: read, error: readError } =
						await folder.files.read(path);
					if (readError) return Err(readError.message);
					captured = { ...read, text: undefined };
				}
			}
			let title: string | undefined;
			if (noteIdOf(path) !== undefined && captured.text !== undefined) {
				// A note whose text does not parse is named by nothing but its file.
				const read = inspectRow(
					honeycrispDefinition.tables.notes,
					captured.text,
				);
				title = displayTitle(read.fields.title, read.body);
			}
			return Ok({
				kind: 'file',
				file: { path, sha256: captured.sha256 },
				title,
			});
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		async remove(deletion: Deletion): Promise<string | undefined> {
			const path =
				deletion.kind === 'folder' ? deletion.path : deletion.file.path;
			const blocked = held(path);
			if (blocked !== undefined) return blocked;
			if (deletion.kind === 'folder') {
				const change = {
					kind: 'rmdir',
					path,
					label: `Delete folder "${basename(path)}"`,
				} as const;
				const removed = await send(
					pathsOf(change),
					() => removeDirectory(folder.files, path),
					keep(change),
				);
				await refresh();
				return replyTo(removed, change);
			}
			const note = noteAt(path);
			if (note !== undefined) {
				// The file goes only as the person confirmed it: nothing is read
				// again, and a write that landed since makes the folder refuse. A
				// write still running finishes first. The session keeps an unknown
				// outcome itself. Its input is fenced in this turn, before the
				// reservation's work begins.
				const removed = await note.operate(() =>
					reserve([path], async () => {
						const { error } = await note.waitForSaves();
						if (error !== null || note.unsettled)
							return { kind: 'unsettled' } as const;
						const step = { kind: 'remove', from: deletion.file } as const;
						note.track(step);
						const answer = await removeFile(folder.files, deletion.file);
						note.conclude(step, answer);
						return answer;
					}),
				);
				if (removed.kind === 'done' && noteAt(path) === note && !note.unsettled)
					forget(path);
				await refreshAll();
				return problemOf(removed);
			}
			const session = sessionAt(path);
			if (session !== undefined) {
				// The confirmation is modal, but a save may have started or failed
				// since the capture. The session keeps an unknown outcome itself.
				const removed = await session.remove(deletion.file);
				if (removed.kind === 'done' && !session.dirty) forget(path);
				await refreshAll();
				return problemOf(removed);
			}
			const change = {
				kind: 'remove',
				from: deletion.file,
				label: `Delete "${basename(path)}"`,
			} as const;
			const removed = await send(
				pathsOf(change),
				() => removeFile(folder.files, deletion.file),
				keep(change),
			);
			if (removed.kind === 'done') forget(path);
			await refreshAll();
			return replyTo(removed, change);
		},
		/** Commit the saved files now. Unsaved editor input is not included. */
		commitNow: (): ReturnType<typeof folder.git.commit> =>
			fenced
				? Promise.resolve({ status: 'blocked', reason: CLOSING })
				: folder.git.commit(),
		/**
		 * Try to save every text draft, and wait for every save already
		 * admitted and every change already sent for a file with no editor. The
		 * caller fences input first. A note has nothing to submit: its editor
		 * took every edit at once, so this waits for its writes and never tries
		 * a failed one again. Resolves how many things closing now would leave
		 * unaccounted for: drafts that are not saved, saves that failed or were
		 * not confirmed, and changes that were never confirmed.
		 */
		async settleAll(): Promise<number> {
			await Promise.all([
				...allSessions().map((session) => session.settle()),
				...allNotes().map((session) => session.waitForSaves()),
				...working.keys(),
			]);
			return unaccounted();
		},
		/**
		 * Fence input for good, abandon editors still being opened, save what
		 * may be saved, and release the folder. A second call returns the same
		 * promise.
		 */
		close(): Promise<void> {
			closing ??= (async () => {
				fenced = true;
				unsubscribeChanges();
				// An opening that answers anyway is not kept where it lands.
				for (const controller of opening) controller.abort();
				await Promise.all(working.keys());
				for (const session of allSessions()) {
					await session.settle();
					session.dispose();
				}
				for (const session of allNotes()) {
					await session.waitForSaves();
					session.release();
				}
				unsubscribeGit();
				await host.close();
			})();
			return closing;
		},
	};
}
