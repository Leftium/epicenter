/**
 * The Honeycrisp product state over one opened notes folder.
 *
 * Three observations refresh together: note rows, folder rows, and the file
 * listing the file browser shows. They refresh after saves and terminal
 * commands, when the window regains focus, and when the folder hints that
 * files changed. Every open session is told what the refresh found, so a
 * clean one follows the file and a dirty one keeps its text.
 *
 * Every opened file has one session, kept by path, and never two:
 *
 * - A note is a row editor (`folder.tables.notes.edit`) retained in a
 *   `RowSession`. Its title, folder, pin, rich-text, and Markdown controls
 *   all change that one document, and a save writes the complete canonical
 *   document. Opening a note writes nothing.
 * - A note file the row editor cannot hold, and every other text file, is a
 *   raw `FileSession` over the file's exact text. A note is repaired there
 *   and opened as a note again when its text is clean.
 *
 * A structured change to a row with no session (a pin from the list, a
 * folder's name, a new note or folder) opens that table's row editor or
 * creates the row, once. A change to any other file with no session (a
 * rename or delete from the file browser) is one call on a capture. When the
 * folder cannot say whether it happened, it is kept in `pending`. It is never
 * reported as failed, never sent again by itself, and never replaced by a new
 * one with a fresh name.
 *
 * Selecting another file never discards a session, and rename, delete, and
 * close settle or refuse instead of dropping input.
 */
import {
	type FileCapture,
	type FileListing,
	type FileTable,
	type GitSnapshot,
	type RowChange,
	type RowEditor,
	rowPath,
	rowStemOf,
	type TableEditError,
} from '@epicenter/folder';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FolderEntry,
	type FolderFields,
	folderLabel,
	NOTES,
	type NoteEntry,
	type NoteFields,
	noteIdOf,
	notePath,
	instantNow as now,
	repairReason,
} from './data.js';
import {
	ask,
	createFile,
	createFileSession,
	type FileOutcome,
	type FileSession,
	makeDirectory,
	moveFile,
	type Observed,
	removeDirectory,
	removeFile,
} from './file-session.svelte.js';
import {
	ancestorsOf,
	basename,
	type Capture,
	dirname,
	joinPath,
	nameProblem,
	readTextFile,
	submittedText,
} from './files.js';
import { displayTitle } from './note-source.js';
import type { NotesHost } from './platform/types.js';
import { createRowSession, type RowSession } from './row-session.svelte.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Notes = ReturnType<typeof createNotes>;

/** One open note: its retained row editor and the app's policy around it. */
export type NoteSession = RowSession<NoteFields>;

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
	| {
			readonly kind: 'text';
			readonly session: FileSession;
			/**
			 * Why a note file opened as text although its text reads as a note:
			 * the row editor could not hold it when it was opened.
			 */
			readonly refusal?: string;
	  }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

export type Selection =
	| {
			readonly kind: 'note';
			readonly session: NoteSession;
			/** The same across a rename; a view of this note is keyed on it. */
			readonly key: object;
	  }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

type Table = 'notes' | 'folders';
type NoteEditor = RowEditor<NoteFields>;

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
			/** Fields of a row with no open session, saved by a row editor opened for it. */
			readonly kind: 'changeRow';
			readonly table: Table;
			readonly path: string;
			readonly stem: string;
			readonly fields: Partial<NoteFields> | Partial<FolderFields>;
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
 * Why a row editor refused a file for its text, or undefined when it refused
 * it for another reason. The library's own message names its terms; this is
 * the part a person can act on.
 */
function repairOf(error: TableEditError): string | undefined {
	switch (error.name) {
		case 'NoCanonicalForm':
			return error.refusal.reason;
		case 'InvalidSource':
			return (
				error.reading.parseError?.message ??
				error.reading.issues[0]?.message ??
				'a field needs fixing'
			);
		default:
			return undefined;
	}
}

/** Why a row editor could not be opened, in words a person can act on. */
function editProblem(error: TableEditError): string {
	const repair = repairOf(error);
	if (repair !== undefined)
		return `This file needs repair before it can be changed here (${repair}). Open it to repair it as text.`;
	return error.name === 'NotFound'
		? 'This file is no longer in the folder.'
		: error.message;
}

/** Why a save that was asked for did not end saved, or undefined when it did. */
function saveProblem(session: FileSession): string | undefined {
	switch (session.status) {
		case 'failed':
			return session.failure;
		case 'conflict':
			return 'The file changed elsewhere. Open it to choose which sha256 to keep.';
		case 'unconfirmed':
			return session.pathChange !== undefined
				? 'A rename or delete of this file was not confirmed. Open it to see where it stands.'
				: 'The save was not confirmed, so it may or may not be in the file. Open it to save again or keep the file.';
		default:
			return undefined;
	}
}

const captureOf = ({ path, source, sha256 }: Capture): Capture => ({
	path,
	source,
	sha256,
});

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
	// A hint says to read again; it is never used as what was read.
	const unsubscribeChanges = folder.onFilesChanged(() => void refreshAll());

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
		pending.length +
		working.size;

	/** A path owns one raw session, begun from what was read or written there. */
	function sessionFor(initial: Capture, refusal?: string): FileSession {
		const existing = sessionAt(initial.path);
		if (existing !== undefined) return existing;
		const session = createFileSession(folder.files, initial, {
			onSaved() {
				rehome(session);
				void refresh();
			},
			admits: () => !fenced,
		});
		openFiles.set(initial.path, { kind: 'text', session, refusal });
		return session;
	}

	/** A note session over an editor the caller opened. The caller keeps it under its path. */
	function noteSession(editor: NoteEditor): NoteSession {
		return createRowSession(editor, {
			admits: () => !fenced,
			onSaved: () => void refresh(),
		});
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
		else if (file?.kind === 'note') void file.session.dispose();
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
					(session.pathChange?.kind === 'move' &&
						paths.includes(session.pathChange.to)) ||
					(session.attempt !== undefined &&
						session.attempt.path !== session.path &&
						paths.includes(session.attempt.path)),
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
			if (
				outcome.kind === 'unconfirmed' ||
				outcome.kind === 'sourceNotRemoved'
			)
				pending = [
					...pending,
					{ ...change, state: outcome.kind, problem: outcome.message },
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
	 * Change fields of a row that has no open session: open its table's row
	 * editor, change the fields, and save the complete document once. Nothing
	 * is saved when the fields already hold those values. The fence is checked
	 * again where the save would be admitted.
	 */
	async function changeRowFile<TFields>(
		table: Pick<FileTable<TFields>, 'edit'>,
		stem: string,
		fields: RowChange<TFields>['fields'],
	): Promise<FileOutcome<unknown>> {
		let opened: Awaited<ReturnType<typeof table.edit>>;
		try {
			opened = await table.edit(stem);
		} catch (cause) {
			return {
				kind: 'failed',
				name: 'Thrown',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
		if (opened.error !== null)
			return {
				kind: 'failed',
				name: opened.error.name,
				message: editProblem(opened.error),
			};
		const editor = opened.data;
		try {
			const changed = editor.change({ fields });
			if (changed.error !== null)
				return {
					kind: 'failed',
					name: changed.error.name,
					message: changed.error.message,
				};
			if (!editor.get().isDirty) return { kind: 'done', value: undefined };
			if (fenced) return { kind: 'failed', name: 'Closing', message: CLOSING };
			return await ask(() => editor.save());
		} finally {
			// Settles after the save; a storage bug already reached `save`.
			await editor.dispose().catch(() => {});
		}
	}

	function changeRow(change: Extract<SentChange, { kind: 'changeRow' }>) {
		return change.table === 'notes'
			? changeRowFile(
					folder.tables.notes,
					change.stem,
					change.fields as Partial<NoteFields>,
				)
			: changeRowFile(
					folder.tables.folders,
					change.stem,
					change.fields as Partial<FolderFields>,
				);
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
						typeof value === 'string' ? submittedText(value).source : value,
					),
		);
	}

	/** The text a path holds in what was just listed, or what a read finds. */
	async function sourceAt(path: string): Promise<string | undefined> {
		const row = [...notes, ...folders].find((entry) => entry.path === path);
		if (row !== undefined) return row.source;
		if (!listing?.files.some((file) => file.path === path)) return undefined;
		const read = await readTextFile(folder.files, path).catch(() => undefined);
		return read?.data?.kind === 'text' ? read.data.file.source : undefined;
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
			if (reached) next.add(change);
		}
		found = next;
	}

	/**
	 * Read an open note again. A note with nothing unsaved and nothing
	 * outstanding follows its file: gone, it is forgotten; no longer
	 * something the row editor can hold, it opens as text to repair. A note
	 * with a draft keeps it whatever is read.
	 */
	async function followNote(
		path: string,
		file: Extract<OpenFile, { kind: 'note' }>,
	) {
		const { session } = file;
		await session.refresh();
		if (closing !== undefined) return;
		if (openFiles.get(path) !== file || session.unsettled) return;
		const seen = session.state.observation;
		if (seen.kind === 'missing') forget(path);
		else if (seen.kind === 'invalid' || seen.kind === 'unsupported') {
			openFiles.delete(path);
			void session.dispose();
			sessionFor(
				seen.file,
				seen.kind === 'unsupported' ? seen.refusal.reason : undefined,
			);
		}
	}

	async function refreshOnce() {
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
			listError = cause instanceof Error ? cause.message : String(cause);
			return;
		}
		if (rows.error) {
			// Never show an empty list for a failed read.
			listError = rows.error.message;
		} else {
			listError = undefined;
			// A file that was read is a note to select, whether or not its text
			// parses. A file that could not be read has no text to open.
			notes = rows.data.flatMap(({ result }) => result.data ?? []);
			unreadable = rows.data.flatMap(({ path, result }) =>
				result.error ? { path, message: result.error.message } : [],
			);
		}
		if (!folderRows.error) {
			folders = folderRows.data.flatMap(({ result }) => result.data ?? []);
			unreadableFolders = folderRows.data.flatMap(({ path, result }) =>
				result.error ? { path, message: result.error.message } : [],
			);
		}
		if (files.error) {
			listingError = files.error.message;
		} else {
			listingError = undefined;
			listing = files.data;
		}
		if (!rows.error && !folderRows.error && !files.error)
			await observePending();
		const present = new Map(notes.map((entry) => [entry.path, entry]));
		const broken = new Map(unreadable.map((item) => [item.path, item]));
		const paths = new Set(files.data?.files.map((file) => file.path));
		const following: Promise<void>[] = [];
		for (const { path, file, saved } of opened) {
			if (openFiles.get(path) !== file) continue;
			if (file.kind === 'loading') continue;
			// A note's row editor reads its own file.
			if (file.kind === 'note') {
				following.push(followNote(path, file));
				continue;
			}
			if (file.kind !== 'text') {
				if (!files.error && !paths.has(path)) openFiles.delete(path);
				continue;
			}
			// A save, a rename, or an adopted file since the listing began makes
			// the listing older than what the session holds.
			if (file.session.saved !== saved) continue;
			let outcome: ReturnType<FileSession['observe']>;
			if (noteIdOf(path) !== undefined) {
				if (rows.error) continue;
				const entry = present.get(path);
				const failed = broken.get(path);
				const observed: Observed =
					entry !== undefined
						? { kind: 'present', file: captureOf(entry) }
						: failed !== undefined
							? { kind: 'unreadable', message: failed.message }
							: { kind: 'removed' };
				outcome = file.session.observe(observed);
			} else {
				if (files.error) continue;
				outcome = paths.has(path)
					? await file.session.reread()
					: file.session.observe({ kind: 'removed' });
			}
			// The path may have been renamed or explicitly discarded during the read.
			if (outcome === 'gone' && openFiles.get(path) === file) forget(path);
		}
		await Promise.all(following);
	}

	/** One refresh at a time; a request during one runs once more afterwards. */
	function refresh(): Promise<void> {
		if (refreshing !== undefined) {
			refreshAgain = true;
			return refreshing;
		}
		refreshing = (async () => {
			try {
				do {
					refreshAgain = false;
					await refreshOnce();
				} while (refreshAgain);
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	}

	async function refreshAll() {
		await Promise.all([refresh(), folder.git.status().catch(() => undefined)]);
	}

	/**
	 * Select a file without replacing any session already kept for its path.
	 * A note opens its row editor; a note file that editor cannot hold, and
	 * any other text file, opens as text.
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
			known?.kind === 'loading'
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
		let refusal: string | undefined;
		if (stem !== undefined) {
			const controller = new AbortController();
			opening.add(controller);
			const edited = await folder.tables.notes
				.edit(stem, { signal: controller.signal })
				.catch(() => undefined)
				.finally(() => opening.delete(controller));
			// An editor that opened anyway after the page began closing is not
			// kept: nothing would dispose it.
			if (closing !== undefined) {
				void edited?.data?.dispose();
				if (openFiles.get(path) === loading) openFiles.delete(path);
				return;
			}
			const blockedNow = pathProblem(path);
			if (openFiles.get(path) !== loading || blockedNow !== undefined) {
				void edited?.data?.dispose();
				if (openFiles.get(path) === loading && blockedNow !== undefined)
					openFiles.set(path, { kind: 'failed', message: blockedNow });
				return;
			}
			if (edited !== undefined && edited.error === null) {
				openFiles.set(path, {
					kind: 'note',
					session: noteSession(edited.data),
					key: {},
				});
				return;
			}
			// Anything else opens as a file: its own read says what it is.
			if (edited?.error.name === 'NoCanonicalForm')
				refusal = edited.error.refusal.reason;
		}
		const read = await readTextFile(folder.files, path).catch(
			(cause: unknown) => ({
				data: null,
				error: {
					name: 'Thrown',
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		);
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
		if (read.error)
			openFiles.set(path, {
				kind: 'failed',
				message:
					read.error.name === 'NotFound'
						? 'This file is no longer in the folder.'
						: read.error.message,
			});
		else if (read.data.kind === 'text') {
			openFiles.delete(path);
			sessionFor(read.data.file, refusal);
		} else openFiles.set(path, read.data);
	}

	/**
	 * Change a row's fields. An open note takes the change in its document, so
	 * it joins whatever is being typed instead of racing it. A row with no
	 * session is changed by a row editor opened for it, once. A file open as
	 * text with unsaved edits is not changed from here.
	 */
	async function changeFields(
		table: Table,
		path: string,
		fields: Partial<NoteFields> | Partial<FolderFields>,
		{ save = 'now' }: { save?: 'now' | 'later' } = {},
	): Promise<string | undefined> {
		const blocked = held(path);
		if (blocked !== undefined) return blocked;
		const session = noteAt(path);
		if (session !== undefined) {
			if (!session.change({ fields: fields as Partial<NoteFields> }))
				return session.admitting ? session.refusal : CLOSING;
			if (save === 'later') return undefined;
			if (session.external !== undefined)
				return 'The file changed elsewhere. Open the note to choose which version to keep.';
			return session.saveNow();
		}
		// A file open as text is that session's: a second editor would race its
		// typing. The person opens it as a note to change its fields.
		if (sessionAt(path) !== undefined)
			return 'This file is open as text. Open it as a note to change it here.';
		const stem = rowStemOf(table, path);
		if (stem === undefined) return 'This file is not a row of its table.';
		const change = {
			kind: 'changeRow',
			table,
			path,
			stem,
			fields,
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
			fields,
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
	 * Rename an open note. Its editor is fixed to its path: once the move is
	 * confirmed, an editor opened at the new path takes the document, with
	 * anything typed during the move, and the old one is disposed. Nothing is
	 * saved to either path meanwhile, and nothing is written back to the old.
	 */
	async function renameNote(
		session: NoteSession,
		path: string,
		to: string,
	): Promise<FileOutcome<unknown> | { readonly kind: 'unsettled' }> {
		const stem = noteIdOf(to);
		return reserve([path, to], async () => {
			const moved = await session.changePath(
				(from) => ({ kind: 'move', from, to }),
				(from) => moveFile(folder.files, from, to),
			);
			if (moved.kind !== 'done' || stem === undefined) return moved;
			const edited = await folder.tables.notes.edit(stem).catch(
				(cause: unknown) =>
					({
						data: null,
						error: {
							name: 'Thrown',
							message: cause instanceof Error ? cause.message : String(cause),
						},
					}) as const,
			);
			const file = openFiles.get(path);
			if (file?.kind !== 'note' || file.session !== session) {
				void edited.data?.dispose();
				return moved;
			}
			if (edited.error !== null) {
				session.strand(
					(edited.error.name === 'Thrown'
						? undefined
						: repairOf(edited.error)) ?? edited.error.message,
				);
				return moved;
			}
			// One step, so no keystroke falls between the two editors.
			const next = noteSession(edited.data);
			next.carry(session.state.document);
			openFiles.delete(path);
			openFiles.set(to, { kind: 'note', session: next, key: file.key });
			if (selectedPath === path) selectedPath = to;
			void session.dispose();
			return moved;
		});
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
		 * same name; a row's fields are changed again on the file as it is now.
		 * Only a confirmed reply ends the record. A refusal leaves it as it was:
		 * finding the result there does not say which attempt made it. A rename,
		 * a delete, and a removed directory cannot be sent again.
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
			const created = await createRow(
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
			if (created.error !== null) return created.error;
			await refresh();
			await open(created.data);
			return undefined;
		},
		patchNote: (
			path: string,
			fields: Partial<NoteFields>,
			options?: { save?: 'now' | 'later' },
		) => changeFields('notes', path, fields, options),
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
			const created = await createRow(
				'folders',
				{ name, icon: null },
				label,
			);
			await refresh();
			return created.error ?? undefined;
		},
		patchFolder: (entry: FolderEntry, fields: Partial<FolderFields>) =>
			changeFields('folders', entry.path, fields),
		/**
		 * Delete a folder after moving its notes out. A note that cannot be
		 * moved stops the operation before the folder goes, so it can be retried
		 * without leaving a note pointing at a folder that no longer exists.
		 * The folder's file is removed only as it was listed when this was asked.
		 *
		 * Moving every note out needs every note's folder to be known, and each
		 * note in the folder to be one the row editor can save. A note whose
		 * text does not parse, whose `folderId` did not validate, or whose file
		 * could not be read might be in this folder, and a note in it with a
		 * field that needs repair cannot be saved as a note. The folder is not
		 * deleted until those are repaired. Not knowing is not the same as no.
		 */
		async deleteFolder(entry: FolderEntry): Promise<string | undefined> {
			const blocked = held(entry.path);
			if (blocked !== undefined) return blocked;
			if (listError !== undefined)
				return `The notes could not be listed, so it is not known which are in this folder: ${listError}`;
			// A folder's id is its literal file stem, whatever that name is.
			const id = entry.stem;
			const named = (items: readonly { path: string }[]) => {
				const names = items.slice(0, 3).map((note) => basename(note.path));
				if (items.length > names.length) names.push('and more');
				return names.join(', ');
			};
			const unknown = [
				...notes.filter((note) => !Object.hasOwn(note.fields, 'folderId')),
				...unreadable,
			];
			if (unknown.length > 0)
				return `Some notes cannot be read well enough to tell which folder they are in (${named(unknown)}). Repair or remove them first, so no note is left pointing at a folder that is gone.`;
			const members = notes.filter((item) => item.fields.folderId === id);
			const needRepair = members.filter(
				(note) => repairReason(note) !== undefined,
			);
			if (needRepair.length > 0)
				return `Some notes in this folder need repair before they can be moved out (${named(needRepair)}). Repair them first.`;
			// Refused before any note moves, so no note is left half moved out.
			const asText = members.filter((note) => sessionAt(note.path) !== undefined);
			if (asText.length > 0)
				return `Some notes in this folder are open as text (${named(asText)}). Open them as notes first.`;
			for (const note of members) {
				const problem = await changeFields('notes', note.path, {
					folderId: null,
				});
				if (problem !== undefined)
					return `A note could not be moved out of the folder: ${problem}`;
			}
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
		 * A raw draft whose file was removed or became unreadable: save it as a
		 * file again. Its own path is used when that is free. A note file whose
		 * path turns out to hold other text becomes a new note; any other file
		 * stays a draft, in conflict with what is there.
		 *
		 * A draft whose earlier save was not confirmed is not saved a second
		 * time somewhere else: that same save is sent again to its same path.
		 */
		async recoverDraft(path: string): Promise<string | undefined> {
			const blocked = held(path);
			if (blocked !== undefined) return blocked;
			const session = sessionAt(path);
			if (session === undefined) return 'There is no draft to save.';
			if (session.status === 'unconfirmed') await session.retry();
			else {
				const reviewed = session.external;
				// Nothing is missing: an earlier save turned out to be in the file.
				if (reviewed === undefined) return undefined;
				if (reviewed.kind === 'changed')
					return 'The file is in the folder. Compare it with your draft to choose.';
				await session.saveMine(
					reviewed,
					noteIdOf(path) !== undefined ? () => notePath(newId()) : undefined,
				);
			}
			// What this save came to, before the refresh below observes anything newer.
			const problem = saveProblem(session);
			await refresh();
			return problem;
		},
		/**
		 * Explicitly discard a draft whose file is gone, unreadable, (for a
		 * note) no longer something the row editor can hold, or whose rename or
		 * delete the person stopped tracking. A note's file that is still there
		 * but cannot be held as a note then opens as text to repair. Nothing is
		 * written: the file stays as it is.
		 */
		discardDraft(path: string) {
			if (fenced) return;
			const file = openFiles.get(path);
			if (file?.kind === 'note') {
				const { session } = file;
				const seen = session.external;
				if (
					session.state.saving !== undefined ||
					session.pathChange !== undefined
				)
					return;
				if (seen === undefined || seen.kind === 'present') {
					if (session.hold?.kind === 'detached') forget(path);
					return;
				}
				if (seen.kind === 'invalid' || seen.kind === 'unsupported') {
					openFiles.delete(path);
					void session.dispose();
					sessionFor(
						seen.file,
						seen.kind === 'unsupported' ? seen.refusal.reason : undefined,
					);
				} else forget(path);
				return;
			}
			const session = file?.kind === 'text' ? file.session : undefined;
			// A draft with something still outstanding is not discarded from here.
			if (session?.attempt !== undefined || session?.pathChange !== undefined)
				return;
			const external = session?.external;
			// A draft whose rename or delete the person stopped tracking is theirs
			// to discard, whatever is at its path now. Nothing is written.
			if (
				session?.detached !== undefined ||
				(external !== undefined && external.kind !== 'changed')
			)
				forget(path);
		},
		/**
		 * Stop tracking a rename or delete of an open file that is not
		 * accounted for: one whose reply was lost, a move that kept its source,
		 * or a renamed note that could not be opened at its new name. Nothing is
		 * concluded about where the file is. The draft stays, nothing is saved
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
		 * Put a committed version of a note in its draft: its fields that read
		 * as valid, and its body. Fields it lacks or holds invalid values for,
		 * and keys Honeycrisp does not declare, stay as the draft has them.
		 * Nothing is saved until the draft saves.
		 */
		useVersion(session: NoteSession, source: string): string | undefined {
			if (fenced) return CLOSING;
			const version = folder.tables.notes.inspect(source);
			if (version.body === undefined)
				return `This version does not read as a note (${version.parseError?.message}). Open the file in Files to use it as text.`;
			if (!session.change({ fields: version.fields, body: version.body }))
				return session.admitting ? session.refusal : CLOSING;
			return undefined;
		},
		/**
		 * Edit an open note's file as text, for what its controls cannot
		 * change, such as a key Honeycrisp does not know. The note must have
		 * nothing unsaved or outstanding: its row editor is disposed, and one
		 * session, the raw one, holds the path afterwards.
		 */
		async editAsFile(path: string): Promise<string | undefined> {
			const blocked = held(path);
			if (blocked !== undefined) return blocked;
			const session = noteAt(path);
			if (session === undefined) return undefined;
			if (!(await session.settle()) || session.external !== undefined)
				return UNSETTLED;
			if (fenced) return CLOSING;
			if (noteAt(path) !== session || session.unsettled) return UNSETTLED;
			const { baseline } = session.state;
			openFiles.delete(path);
			void session.dispose();
			sessionFor({
				path,
				sha256: baseline.sha256,
				source: baseline.source,
			});
			return undefined;
		},
		/**
		 * Open a note file being edited as text as a note again. Its text must
		 * be saved and readable by the row editor; otherwise it stays as text.
		 */
		async openAsNote(path: string): Promise<string | undefined> {
			const blocked = held(path);
			if (blocked !== undefined) return blocked;
			const session = sessionAt(path);
			const stem = noteIdOf(path);
			if (session === undefined || stem === undefined) return undefined;
			if (!(await session.settle())) return UNSETTLED;
			return reserve([path], async () => {
				const edited = await folder.tables.notes.edit(stem).catch(
					(cause: unknown) =>
						({
							data: null,
							error: {
								name: 'Thrown',
								message:
									cause instanceof Error ? cause.message : String(cause),
							},
						}) as const,
				);
				if (edited.error !== null) {
					const repair =
						edited.error.name === 'Thrown' ? undefined : repairOf(edited.error);
					return repair === undefined
						? edited.error.message
						: `This file cannot be opened as a note yet (${repair}).`;
				}
				if (fenced) {
					void edited.data.dispose();
					return CLOSING;
				}
				if (sessionAt(path) !== session || session.unsettled) {
					void edited.data.dispose();
					return UNSETTLED;
				}
				// The editor read the file again. Unless it read exactly the bytes
				// the text draft agrees with, another program wrote in between, and
				// a change hint is no promise to arrive in time: the text stays.
				if (edited.data.get().baseline.sha256 !== session.saved.sha256) {
					void edited.data.dispose();
					void refresh();
					return 'The file changed while it was being opened as a note, so it stays open as text. Check it and try again.';
				}
				session.dispose();
				openFiles.set(path, {
					kind: 'note',
					session: noteSession(edited.data),
					key: {},
				});
				return undefined;
			});
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
				await refreshAll();
				if (outcome.kind === 'done' && note?.pathChange?.state === 'stranded')
					return `The note was renamed to "${name}" but could not be opened there: ${note.pathChange.problem}`;
				return problemOf(outcome);
			}
			let reopen = false;
			const reply = await reserve([path, to], async () => {
				const read = await folder.files.read(path);
				if (read.error) return read.error.message;
				const from: FileCapture = { path, sha256: read.data.sha256 };
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
		 * An open file is captured as its session holds it, after pending typing
		 * is saved; a session that cannot settle refuses, so no deletion discards
		 * input. Only empty directories can be deleted.
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
			if (note !== undefined) {
				if (!(await note.settle()) || note.external !== undefined)
					return Err(UNSETTLED);
				const { baseline, reading, document } = note.state;
				return Ok({
					kind: 'file',
					file: { path, sha256: baseline.sha256 },
					title: displayTitle(reading.fields.title, document.body),
				});
			}
			const session = sessionAt(path);
			let captured: FileCapture & { source: string | undefined };
			if (session !== undefined) {
				if (!(await session.settle())) return Err(UNSETTLED);
				captured = session.saved;
			} else {
				const listed = notes.find((entry) => entry.path === path);
				if (listed !== undefined) captured = listed;
				else {
					const read = await folder.files.read(path);
					if (read.error) return Err(read.error.message);
					captured = { ...read.data, source: undefined };
				}
			}
			let title: string | undefined;
			if (noteIdOf(path) !== undefined && captured.source !== undefined) {
				// A note whose text does not parse is named by nothing but its file.
				const read = folder.tables.notes.inspect(captured.source);
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
				// The session keeps an unknown outcome itself. Typing that arrived
				// while the file was removed stays a draft.
				const removed = await reserve([path], () =>
					note.changePath(
						() => ({ kind: 'remove', from: deletion.file }),
						(from) => removeFile(folder.files, from),
					),
				);
				if (removed.kind === 'done' && noteAt(path) === note && !note.dirty)
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
		 * Try to save every draft, and wait for every save already admitted and
		 * every change already sent for a file with no editor. Resolves how many
		 * things closing now would leave unaccounted for: drafts that are not
		 * saved, and changes that were never confirmed.
		 */
		async settleAll(): Promise<number> {
			await Promise.all([
				...allSessions().map((session) => session.settle()),
				...allNotes().map((session) => session.settle()),
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
				// An opening that answers anyway disposes its editor where it lands.
				for (const controller of opening) controller.abort();
				await Promise.all(working.keys());
				for (const session of allSessions()) {
					await session.settle();
					session.dispose();
				}
				for (const session of allNotes()) {
					await session.settle();
					await session.dispose();
				}
				unsubscribeGit();
				unsubscribeChanges();
				await host.close();
			})();
			return closing;
		},
	};
}
