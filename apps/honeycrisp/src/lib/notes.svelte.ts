/**
 * The Honeycrisp product state over one opened notes folder.
 *
 * Three observations refresh together: note rows, folder rows, and the file
 * listing the file browser shows. They refresh after saves and terminal
 * commands, when the window regains focus, and when the folder hints that
 * files changed. Every open session is told what the refresh found, so a
 * clean one follows the file and a dirty one keeps its text.
 *
 * Every open text file has one session, kept by path. A note is a file whose
 * frontmatter the list and the metadata controls read; changing a field is a
 * patch to that file's source, saved the way typing is. Rows are listings
 * only: nothing here writes through a table.
 *
 * A change to a file that has no session (a new note, a field of an unopened
 * note, a rename or delete from the file browser) is one call on a capture.
 * When the folder cannot say whether it happened, it is kept in `pending`
 * exactly as it was sent. It is never reported as failed, never sent again
 * by itself, and never replaced by a new one with a fresh name.
 *
 * Selecting another file never discards a session, and rename, delete, and
 * close settle or refuse instead of dropping input.
 */
import {
	type FileCapture,
	type FileListing,
	type GitSnapshot,
	readSource,
	rowPath,
} from '@epicenter/folder';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FolderEntry,
	type FolderFields,
	NOTES,
	type NoteEntry,
	type NoteFields,
	noteIdOf,
	notePath,
	instantNow as now,
} from './data.js';
import {
	createFile,
	createFileSession,
	type FileOutcome,
	type FileSession,
	makeDirectory,
	moveFile,
	type Observed,
	removeDirectory,
	removeFile,
	replaceFile,
} from './file-session.svelte.js';
import {
	ancestorsOf,
	basename,
	type Capture,
	dirname,
	joinPath,
	nameProblem,
	readTextFile,
} from './files.js';
import { applyFields, displayTitle, newSource } from './note-source.js';
import type { NotesHost } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Notes = ReturnType<typeof createNotes>;

/** An opened file, including notes. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly session: FileSession }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

export type Selection =
	| {
			readonly kind: 'note';
			readonly session: FileSession;
			/** The listed row, or undefined when the file left the folder. */
			readonly entry: NoteEntry | undefined;
	  }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

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

/** One change to a file or directory, exactly as it was sent. */
type SentChange =
	| { readonly kind: 'create'; readonly path: string; readonly source: string }
	| {
			readonly kind: 'replace';
			readonly base: FileCapture;
			readonly source: string;
	  }
	| { readonly kind: 'move'; readonly from: FileCapture; readonly to: string }
	| { readonly kind: 'remove'; readonly from: FileCapture }
	| { readonly kind: 'mkdir' | 'rmdir'; readonly path: string };

/**
 * A change to a file with no open session whose outcome the folder could not
 * confirm, or a move that left both files. It stands until the exact state
 * it asked for is read back (`create`, `replace`, `mkdir`) or the same
 * change is sent again and confirmed. A `move`, `remove`, or `rmdir` has
 * neither: nothing that can be read shows it will not still happen.
 */
export type PendingChange = SentChange & {
	/** What the person asked for, in words they would use. */
	readonly label: string;
	/** `partial`: a move created its destination and did not remove the original. */
	readonly state: 'unconfirmed' | 'partial';
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
		case 'replace':
			return [change.base.path];
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
		default:
			return outcome.message;
	}
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
				: 'The save was not confirmed, so it may or may not be in the file. Open it to send it again.';
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
	let listError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	let git = $state.raw<GitSnapshot>(folder.git.snapshot);
	let selectedPath = $state<string | undefined>();
	/** Bumped when a note is selected, so its editor takes focus. */
	let focusRequest = $state(0);
	/** Set while a close is being answered: no input and no action is taken. */
	let fenced = $state(false);
	let pending = $state.raw<PendingChange[]>([]);
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
	 * collection whole, the note rows, and the path. Svelte re-runs a derived with the
	 * values from before an update while an effect that read it is torn down,
	 * and keeps that run's dependencies. A lookup by the selected key alone
	 * would leave this subscribed to the path just left, so a file that
	 * finishes loading afterwards would never show. Reading the lookup straight
	 * from the accessor does not avoid it: a view's `{@const}` over the
	 * selection is a derived too, and inherits the same keyed dependencies.
	 */
	const selection = $derived.by((): Selection | undefined => {
		const files = new Map(openFiles);
		const rows = notes;
		const path = selectedPath;
		if (path === undefined) return undefined;
		const file = files.get(path);
		if (file?.kind === 'text' && noteIdOf(path) !== undefined)
			return {
				kind: 'note',
				session: file.session,
				entry: rows.find((entry) => entry.path === path),
			};
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

	function sessionAt(path: string): FileSession | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'text' ? file.session : undefined;
	}

	function allSessions(): FileSession[] {
		return [...openFiles.values()].flatMap((file) =>
			file.kind === 'text' ? [file.session] : [],
		);
	}

	const unaccounted = () =>
		allSessions().filter((session) => session.unsettled).length +
		pending.length +
		working.size;

	/** A path owns one session, begun from what was read or written there. */
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

	/** A session that was saved or moved to another path is kept under that path. */
	function rehome(session: FileSession) {
		for (const [path, file] of openFiles)
			if (file.kind === 'text' && file.session === session)
				return follow(path, session.path);
	}

	function forget(path: string) {
		sessionAt(path)?.dispose();
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
		const owner = allSessions().find(
			(session) =>
				(session.pathChange?.kind === 'move' &&
					paths.includes(session.pathChange.to)) ||
				(session.attempt !== undefined &&
					session.attempt.path !== session.path &&
					paths.includes(session.attempt.path)),
		);
		return owner === undefined
			? undefined
			: 'This file belongs to an open draft with an unfinished change. Resolve that draft before editing here.';
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

	/** Keep `change` as it was sent when its outcome is unknown or partial. */
	const keep =
		(change: SentChange & { label: string }) =>
		(outcome: FileOutcome<unknown>) => {
			if (outcome.kind === 'unconfirmed' || outcome.kind === 'partial')
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
		if (outcome.kind === 'partial' && change.kind === 'move')
			return `"${basename(change.to)}" was created, but "${basename(change.from.path)}" could not be removed, so both files exist now. ${outcome.message}`;
		if (outcome.kind === 'failed' && outcome.name === 'DirectoryNotEmpty')
			return 'The folder is not empty, so nothing was deleted.';
		return problemOf(outcome);
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
	 * Drop each pending change whose exact result is what the folder holds
	 * now. That says the state it asked for is there, not that it arrived. A
	 * move, a removal, and a removed directory are never dropped this way.
	 */
	async function reconcilePending() {
		for (const change of pending) {
			const reached =
				change.kind === 'create'
					? (await sourceAt(change.path)) === change.source
					: change.kind === 'replace'
						? (await sourceAt(change.base.path)) === change.source
						: change.kind === 'mkdir'
							? (listing?.directories.includes(change.path) ?? false)
							: false;
			if (reached) pending = pending.filter((item) => item !== change);
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
			notes = [...rows.data.entries];
			unreadable = rows.data.unreadable.map((item) => ({
				path: item.path,
				message: item.error.message,
			}));
		}
		if (!folderRows.error) folders = [...folderRows.data.entries];
		if (files.error) {
			listingError = files.error.message;
		} else {
			listingError = undefined;
			listing = files.data;
		}
		if (!rows.error && !folderRows.error && !files.error)
			await reconcilePending();
		const present = new Map(notes.map((entry) => [entry.path, entry]));
		const broken = new Map(unreadable.map((item) => [item.path, item]));
		const paths = new Set(files.data?.files.map((file) => file.path));
		for (const { path, file, saved } of opened) {
			if (openFiles.get(path) !== file) continue;
			if (file.kind === 'loading') continue;
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

	/** Select a file without replacing any session already kept for its path. */
	async function open(path: string) {
		selectedPath = path;
		focusRequest += 1;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const known = openFiles.get(path);
		if (known?.kind === 'text' || known?.kind === 'loading') return;
		// A file with a change outstanding gets no editor: a save from one could
		// land on the wrong side of that change.
		const blocked = pathProblem(path);
		if (blocked !== undefined) {
			openFiles.set(path, { kind: 'failed', message: blocked });
			return;
		}
		const listed = notes.find((entry) => entry.path === path);
		if (listed !== undefined) {
			// The row already holds the file's exact text and sha256.
			sessionFor(captureOf(listed));
			return;
		}
		// Identity, rather than the loading tag, keeps an old read from replacing
		// a newer open after rename, deletion, or an explicit discard.
		const loading: OpenFile = { kind: 'loading' };
		openFiles.set(path, loading);
		const read = await readTextFile(folder.files, path).catch(
			(cause: unknown) => ({
				data: null,
				error: {
					name: 'Thrown',
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		);
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
		else if (read.data.kind === 'text') sessionFor(read.data.file);
		else openFiles.set(path, read.data);
	}

	/**
	 * Change a file's frontmatter fields. An open session takes the change in
	 * its buffer, so it joins whatever is being typed instead of racing it. A
	 * file that is not open is replaced as it was listed, and only if it still
	 * holds those bytes.
	 */
	async function patchFields(
		path: string,
		fields: Partial<NoteFields> | Partial<FolderFields>,
		{ save = 'now' }: { save?: 'now' | 'later' } = {},
	): Promise<string | undefined> {
		const blocked = held(path);
		if (blocked !== undefined) return blocked;
		const session = sessionAt(path);
		if (session !== undefined) {
			const patched = applyFields(session.buffer, fields);
			if (patched.error !== null) {
				session.refuse(patched.error);
				return patched.error;
			}
			if (!session.input(patched.data)) return CLOSING;
			if (save === 'later') return undefined;
			await session.save();
			return saveProblem(session);
		}
		const listed = [...notes, ...folders].find((item) => item.path === path);
		if (listed === undefined) return 'This file is no longer in the folder.';
		const patched = applyFields(listed.source, fields);
		if (patched.error !== null) return patched.error;
		const base: FileCapture = { path, sha256: listed.sha256 };
		const change = {
			kind: 'replace',
			base,
			source: patched.data,
			label: `Change to "${basename(path)}"`,
		} as const;
		const outcome = await send(
			pathsOf(change),
			() => replaceFile(folder.files, base, patched.data),
			keep(change),
		);
		await refresh();
		return replyTo(outcome, change);
	}

	/** Create a file that must not exist yet, from frontmatter fields. */
	async function createRow(
		path: string,
		fields: NoteFields | FolderFields,
		label: string,
	): Promise<Result<Capture, string>> {
		const source = newSource(fields);
		if (source.error !== null) return source;
		const text = source.data;
		const change = { kind: 'create', path, source: text, label } as const;
		const created = await send(
			pathsOf(change),
			() => createFile(folder.files, path, text),
			keep(change),
		);
		if (created.kind === 'done') return Ok(created.value);
		return Err(replyTo(created, change) ?? created.kind);
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
		/** Note files whose bytes could not be read as text. */
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
		/** The one session for an opened text file. */
		sessionAt,
		/**
		 * What leaving now would lose or stop tracking: drafts with typing, an
		 * open change, or a conflict, and changes to files with no editor that
		 * are still being sent or were never confirmed.
		 */
		get unsettled() {
			return unaccounted();
		},
		get saving() {
			return (
				working.size > 0 ||
				allSessions().some((session) => session.status === 'saving')
			);
		},
		/** Sessions whose text is known not to be in its file. */
		get notSaved() {
			return allSessions().filter(
				(session) =>
					session.status === 'failed' || session.status === 'conflict',
			).length;
		},
		/**
		 * Changes that may or may not have happened: open files whose save,
		 * rename, or delete was not confirmed, and every pending change.
		 */
		get unconfirmed() {
			return (
				allSessions().filter((session) => session.status === 'unconfirmed')
					.length + pending.length
			);
		},
		/** Changes to files with no open session whose outcome is not known. */
		get pending() {
			return pending;
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
				fenced = false;
			};
		},
		refresh,
		refreshAll,
		open,
		/**
		 * Send a pending change again, exactly as it was sent: the same path,
		 * text, and condition. A refusal is followed by a read, and the change
		 * is dropped only if that read finds exactly what it asked for. A
		 * rename, a delete, and a removed directory cannot be sent again.
		 */
		async retryPending(change: PendingChange): Promise<string | undefined> {
			if (fenced) return CLOSING;
			if (!pending.includes(change)) return undefined;
			if (
				change.kind !== 'create' &&
				change.kind !== 'replace' &&
				change.kind !== 'mkdir'
			)
				return 'This cannot be sent again: whether it happened is not known, and a second one could act on a different file.';
			const outcome = await send<unknown>(
				pathsOf(change),
				() =>
					change.kind === 'create'
						? createFile(folder.files, change.path, change.source)
						: change.kind === 'replace'
							? replaceFile(folder.files, change.base, change.source)
							: makeDirectory(folder.files, change.path),
				(reply) => {
					// The same record stands, or ends: a resend never adds a second.
					if (reply.kind === 'done')
						pending = pending.filter((item) => item !== change);
				},
			);
			// A refused one may have found its own result there: the refresh reads it.
			await refresh();
			if (!pending.includes(change)) return undefined;
			return replyTo(outcome, change);
		},
		/** Create a note in the folder being shown and open it. */
		async createNote(): Promise<string | undefined> {
			if (fenced) return CLOSING;
			// A second note with a fresh name is not made while the first is unknown.
			if (pending.some((item) => item.label === NEW_NOTE))
				return 'An earlier new note was not confirmed. Send it again from the status menu, or wait for it to appear, before making another.';
			const at = now();
			const created = await createRow(
				notePath(newId()),
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
			const blocked = pathProblem(created.data.path);
			if (blocked !== undefined)
				openFiles.set(created.data.path, { kind: 'failed', message: blocked });
			else sessionFor(created.data);
			selectedPath = created.data.path;
			focusRequest += 1;
			return undefined;
		},
		patchNote: (
			path: string,
			fields: Partial<NoteFields>,
			options?: { save?: 'now' | 'later' },
		) => patchFields(path, fields, options),
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) => patchFields(path, { deletedAt: now() }),
		restoreNote: (path: string) => patchFields(path, { deletedAt: null }),
		async createFolder(name: string): Promise<string | undefined> {
			if (fenced) return CLOSING;
			const label = `New folder "${name}"`;
			if (pending.some((item) => item.label === label))
				return 'This folder was already asked for and not confirmed. Send it again from the status menu, or wait for it to appear.';
			const created = await createRow(
				rowPath(FOLDERS, newId()),
				{ name, icon: null },
				label,
			);
			await refresh();
			return created.error ?? undefined;
		},
		patchFolder: (entry: FolderEntry, fields: Partial<FolderFields>) =>
			patchFields(entry.path, fields),
		/**
		 * Delete a folder after moving its notes out. A note that cannot be
		 * moved stops the operation before the folder goes, so it can be retried
		 * without leaving a note pointing at a folder that no longer exists.
		 * The folder's file is removed only as it was listed when this was asked.
		 */
		async deleteFolder(entry: FolderEntry): Promise<string | undefined> {
			const blocked = held(entry.path);
			if (blocked !== undefined) return blocked;
			// Notes name a folder by its file stem. One that breaks the naming
			// rules is repaired from Files before its notes are moved by it.
			if (entry.issues?.some((issue) => issue.kind === 'filename'))
				return 'This folder file has an unusable name.';
			const id = entry.stem;
			for (const note of notes.filter((item) => item.fields.folderId === id)) {
				const problem = await patchFields(note.path, { folderId: null });
				if (problem !== undefined)
					return `A note could not be moved out of the folder: ${problem}`;
			}
			const from: FileCapture = { path: entry.path, sha256: entry.sha256 };
			const change = {
				kind: 'remove',
				from,
				label: `Delete folder "${entry.fields.name ?? id}"`,
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
		 * A draft whose file was removed or became unreadable: save it as a
		 * file again. Its own path is used when that is free. A note whose path
		 * turns out to hold other text becomes a new note; any other file stays
		 * a draft, in conflict with what is there.
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
		/** Explicitly discard a draft whose file is gone or unreadable. */
		discardDraft(path: string) {
			if (fenced) return;
			const session = sessionAt(path);
			// A draft with something still outstanding is not discarded from here.
			if (session?.attempt !== undefined || session?.pathChange !== undefined)
				return;
			const external = session?.external;
			if (external !== undefined && external.kind !== 'changed') forget(path);
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
			if (sessionAt(to) !== undefined)
				return `A draft for "${name}" is still open. Save or discard it before renaming another file to this name.`;
			if (notePaths.has(path) && noteIdOf(to) === undefined)
				return 'A note file keeps its .md extension.';
			const session = sessionAt(path);
			if (session !== undefined) {
				// The session keeps an unknown or partial outcome itself.
				const outcome = await reserve([path, to], () => session.move(to));
				await refreshAll();
				if (outcome.kind === 'partial')
					return `"${name}" was created, but "${basename(path)}" could not be removed, so both files exist now. ${outcome.message}`;
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
				const read = readSource(captured.source);
				title = displayTitle(read.values?.title, read.body);
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
			const session = sessionAt(path);
			if (session !== undefined) {
				// The confirmation is modal, but a save may have started or failed
				// since the capture. The session keeps an unknown outcome itself.
				const removed = await session.remove(deletion.file);
				if (removed.kind === 'done') forget(path);
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
		 * Try to save every draft, and wait for every change already sent for a
		 * file with no editor. Resolves how many things closing now would leave
		 * unaccounted for: drafts that are not saved, and changes that were
		 * never confirmed.
		 */
		async settleAll(): Promise<number> {
			await Promise.all([
				...allSessions().map((session) => session.settle()),
				...working.keys(),
			]);
			return unaccounted();
		},
		async close() {
			fenced = true;
			await Promise.all(working.keys());
			for (const session of allSessions()) {
				await session.settle();
				session.dispose();
			}
			unsubscribeGit();
			unsubscribeChanges();
			await host.close();
		},
	};
}
