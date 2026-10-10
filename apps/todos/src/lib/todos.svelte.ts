/**
 * The Todos product state over one opened folder.
 *
 * Two listings refresh together: the todo rows in `todos/*.md`, and the
 * folder listing the file browser shows. They are read when the page opens,
 * after each of the app's own actions and terminal commands, and when the
 * person returns to the window. The latest refresh wins. The list offers the
 * rows that read as todos and names the rest, with why, for repair as text.
 *
 * One item is open at a time, in one editing session (`session.svelte.ts`):
 * a todo opened from the list is a row session over its fields and notes; a
 * file opened from Files, or a todo whose text is not a valid row, is a text
 * session over its exact text (`@epicenter/svelte/edit-session`). Leaving an
 * item waits for its saves, then releases its session and lists again. A
 * save that failed or conflicted keeps the item open until the person
 * discards the draft (`open` answers `unsaved`, and the view asks).
 *
 * Returning to the window takes a newer version of the open item when its
 * session holds nothing unsaved. Otherwise the next save reports the change
 * as a conflict, and the person keeps theirs or reloads.
 */
import type {
	AutosaveError,
	CommitAndPushResult,
	FileCapture,
	FileError,
	FileListing,
	MergeOutcome,
	MoveError,
	PullError,
	PullOutcome,
	RecoverOutcome,
	RowReadError,
	StoredRow,
	TableError,
} from '@epicenter/folder';
import { GitError, MergeError, rowPath, rowStemOf } from '@epicenter/folder';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
} from '@epicenter/folder/file-browser';
import {
	createRowSession,
	createTextSession,
	type RowSession,
	type TextSession,
} from '@epicenter/svelte/edit-session';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import { nameProblem, readTextFile } from './files.js';
import type { TodosFolder } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

const log = createLogger('todos');

export type Todos = ReturnType<typeof createTodos>;

/** A todo row as the table last listed it. */
export type TodoEntry = StoredRow<TodoFields> & { readonly stem: string };

/** A row file the list cannot edit, and why, for the person to repair as text. */
type Repair = { readonly path: string; readonly reason: string };

/** The surface a path was opened from, which decides how it is edited. */
export type Workspace = 'files' | 'todos';

/** The one open item: what the detail shows. */
export type Opened =
	| { readonly kind: 'loading'; readonly path: string; readonly workspace: Workspace }
	| { readonly kind: 'todo'; readonly session: RowSession<TodoFields> }
	| {
			readonly kind: 'text';
			readonly workspace: Workspace;
			readonly session: TextSession;
	  }
	| {
			readonly kind: 'failed';
			readonly path: string;
			readonly workspace: Workspace;
			readonly message: string;
	  }
	| {
			readonly kind: 'binary' | 'tooLarge';
			readonly path: string;
			readonly size: number;
	  };

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| (FileCapture & { readonly kind: 'todo'; readonly title: string })
	| (FileCapture & { readonly kind: 'file' })
	| { readonly kind: 'folder'; readonly path: string };

/** What one explicit request to recover the pending incoming update did. */
export type RecoveryAttempt =
	/** The open item holds a draft it could not save; nothing ran. */
	| { readonly kind: 'unsettled'; readonly paths: readonly string[] }
	/** Another change to the folder was in progress; nothing ran. */
	| { readonly kind: 'busy' }
	| {
			readonly kind: 'ran';
			readonly result: Result<RecoverOutcome, PullError | GitError>;
	  };

/** What the terminal close left unsaved. */
export type CloseOutcome = { readonly unsettled: readonly string[] };

/** Why input or a command was refused while Epicenter asks to quit or restart. */
export const DEPARTING =
	'Epicenter is asking to quit or restart, so nothing is changed now. Your edits are kept.';
/** Why a pull or merge stopped after its fetch: Epicenter asked to leave meanwhile. */
const WITHDRAWN =
	'Epicenter asked to quit or restart after the fetch, so nothing was applied. Try again after it finishes or is cancelled.';
const CLOSING = 'Todos is closing, so nothing was changed.';
const BUSY = 'Another change is still in progress. Try again when it finishes.';
/** Why Reload theirs showed nothing: the file is there but is not text. */
const NOT_TEXT =
	'This file is no longer text, so it cannot be shown here. Keep mine saves your version over it.';
/** Why a new file did not open: the open one holds changes it could not save. */
const UNSAVED_STAYS =
	'It was added, but the open file has changes that are not saved, so it stays open.';

/** The path an open item is at. */
export function pathOf(item: Opened): string {
	return item.kind === 'todo' || item.kind === 'text'
		? item.session.path
		: item.path;
}

/** The workspace an open item was opened from. */
export function workspaceOf(item: Opened): Workspace {
	if (item.kind === 'todo') return 'todos';
	return 'workspace' in item ? item.workspace : 'files';
}

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, a move that kept its source left both
 * files, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error:
		| FileError
		| MoveError
		| TableError
		| AutosaveError
		| { readonly name: string; readonly message: string }
		| string,
): string {
	if (typeof error === 'string') return error;
	// A session's own refusals are named failures with a message of their own.
	const known = error as FileError | MoveError | TableError;
	switch (known.name) {
		case 'Exists':
			return `"${basename(known.path)}" already exists here.`;
		case 'Conflict':
			return known.actualSha256 === undefined
				? 'The file is no longer here. Nothing was changed.'
				: 'The file changed elsewhere. Nothing was changed. Check it and try again.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'SourceNotRemoved':
			return `The file was copied to ${known.to}, but ${known.from} could not be removed, so the folder now has both. Delete whichever you do not want.`;
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${known.message}`;
		case 'InvalidValues':
			return known.issues.map((issue) => issue.message).join(' ');
		default:
			return known.message;
	}
}

/** Why a listed row file is not a todo the list can edit. */
function repairOf(path: string, error: RowReadError): Repair {
	if (error.name === 'InvalidRow')
		return {
			path,
			reason: error.issues.map((issue) => issue.message).join(' '),
		};
	return { path, reason: `It could not be read as text: ${error.message}` };
}

function byPath(a: { path: string }, b: { path: string }) {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function createTodos(folder: TodosFolder) {
	const table = folder.tables.todos;
	/** Rows that read as todos: what the list offers to edit. */
	let entries = $state.raw<TodoEntry[]>([]);
	/** Row files the list does not offer, each with why. */
	let repairs = $state.raw<Repair[]>([]);
	/** Every row file in the last listing, todo or not. */
	let rowPaths = $state.raw<ReadonlySet<string>>(new Set());
	let listError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	let opened = $state.raw<Opened | undefined>();
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>(['todos']);
	let refreshSequence = 0;
	/** Advanced by every open, so a load that answers late installs nothing. */
	let openSequence = 0;
	let closing: Promise<CloseOutcome> | undefined;
	/** Aborted when `close` starts: the app's own Git network waits stop. */
	const leaving = new AbortController();
	/**
	 * Operations admitted and not finished: Git commands, recoveries, file
	 * actions, and terminal commands. A departure's drain and `close` wait for
	 * them.
	 */
	const operations = new Set<Promise<unknown>>();
	let recovering = $state(false);
	let lastRecovery = $state.raw<
		(RecoveryAttempt & { readonly at: number }) | undefined
	>();
	/**
	 * Epicenter asks to quit or restart. From `prepareDeparture` until
	 * `resumeDeparture`, no action starts and the open item takes no input;
	 * saves already requested go on.
	 */
	let departing = $state(false);
	/** The title typed for a new todo and not yet added. */
	let newTitle = $state('');

	/** Whether the open item refuses input now. */
	const locked = () => departing || recovering || closing !== undefined;

	/** Why no action starts now, if one does not. */
	function refused(): string | undefined {
		if (closing !== undefined) return CLOSING;
		if (departing) return DEPARTING;
		if (recovering) return BUSY;
		return undefined;
	}

	/** Count `work` as running until it settles. */
	function admitted<T>(work: Promise<T>): Promise<T> {
		operations.add(work);
		const done = () => {
			operations.delete(work);
		};
		work.then(done, done);
		return work;
	}

	async function quiet() {
		while (operations.size > 0) await Promise.allSettled([...operations]);
	}

	function sessionOf(item: Opened | undefined) {
		return item?.kind === 'todo' || item?.kind === 'text'
			? item.session
			: undefined;
	}

	const shell = folder.terminal();
	const terminal = createTerminalSession(
		{
			get cwd() {
				return shell.cwd;
			},
			exec: (command, options) =>
				closing !== undefined
					? Promise.resolve({
							stdout: '',
							stderr: 'The folder is closed\n',
							exitCode: 1,
						})
					: departing
						? Promise.resolve({
								stdout: '',
								stderr: `${DEPARTING}\n`,
								exitCode: 1,
							})
						: admitted(shell.exec(command, options)),
		},
		() => check(),
		() => departing,
	);

	/** One listing pass. A pass that a newer one overtook, or that answers after close began, changes nothing. */
	async function refresh() {
		if (closing !== undefined) return;
		const sequence = ++refreshSequence;
		const [
			{ data: rows, error: rowsError },
			{ data: files, error: filesError },
		] = await Promise.all([table.list(), folder.files.list()]);
		if (closing !== undefined || sequence !== refreshSequence) return;
		if (rowsError) {
			// Keep the previous listing visible; never show an empty list for a failed read.
			listError = rowsError.message;
		} else {
			const valid: TodoEntry[] = [];
			const repair: Repair[] = [];
			for (const { stem, result } of rows) {
				if (result.error === null) valid.push({ ...result.data, stem });
				else repair.push(repairOf(rowPath(table.name, stem), result.error));
			}
			listError = undefined;
			entries = valid.sort((a, b) => {
				const doneA = a.row.fields.done ? 1 : 0;
				const doneB = b.row.fields.done ? 1 : 0;
				return doneA - doneB || byPath(a, b);
			});
			repairs = repair.sort(byPath);
			rowPaths = new Set(rows.map(({ stem }) => rowPath(table.name, stem)));
		}
		if (filesError) listingError = filesError.message;
		else {
			listingError = undefined;
			listing = files;
		}
	}

	/** The listings, Git status, and a newer version of the open item when it holds nothing unsaved. */
	async function check() {
		if (closing !== undefined) return;
		await Promise.all([
			refresh(),
			folder.git.status(),
			sessionOf(opened)?.adopt(),
		]);
	}

	/**
	 * Leave the open item: wait for its saves, then release its session. Answers
	 * false, leaving it open, when a save failed or conflicted, unless the
	 * person chose to discard that session's draft.
	 */
	async function leave(discard: unknown): Promise<boolean> {
		const session = sessionOf(opened);
		if (session === undefined) return true;
		const settled = await session.settled();
		if (settled.status === 'error' && discard !== session) return false;
		session.release();
		return true;
	}

	function openRow(stored: StoredRow<TodoFields>): Opened {
		return {
			kind: 'todo',
			session: createRowSession(table, stored, { locked }),
		};
	}

	function openText(
		file: FileCapture & { text: string },
		workspace: Workspace,
	): Opened {
		return {
			kind: 'text',
			workspace,
			session: createTextSession(folder.files, file, { locked }),
		};
	}

	/** Read `path` the way `workspace` opens it. */
	async function load(path: string, workspace: Workspace): Promise<Opened> {
		const stem = rowStemOf(table.name, path);
		if (workspace === 'todos' && stem !== undefined) {
			const { data: stored, error } = await table.get(stem);
			if (error?.name === 'InvalidRow') return openText(error, 'todos');
			if (error !== null)
				return { kind: 'failed', path, workspace, message: error.message };
			if (stored === undefined)
				return {
					kind: 'failed',
					path,
					workspace,
					message: 'This todo is no longer in the folder.',
				};
			return openRow(stored);
		}
		const { data: read, error } = await readTextFile(folder.files, path);
		if (error !== null)
			return { kind: 'failed', path, workspace, message: error.message };
		if (read.kind !== 'text') return { ...read, path };
		return openText(read.file, workspace);
	}

	/**
	 * Show `path` as `workspace` edits it: Files as the file's text, the todo
	 * list as a todo. The open item's saves land first, and the listings are
	 * read again. Answers `unsaved`, opening nothing, when the open item holds
	 * a draft it could not save; the view asks the person, and `discard`
	 * names the session whose draft they chose to let go.
	 */
	async function open(
		path: string,
		workspace: Workspace,
		{ discard }: { discard?: unknown } = {},
	): Promise<'unsaved' | undefined> {
		if (closing !== undefined) return undefined;
		const sequence = ++openSequence;
		const left = opened;
		if (!(await leave(discard))) return 'unsaved';
		if (left !== undefined) void refresh();
		if (sequence !== openSequence || closing !== undefined) return undefined;
		if (workspace === 'files')
			for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		opened = { kind: 'loading', path, workspace };
		const item = await load(path, workspace);
		if (sequence !== openSequence || closing !== undefined) return undefined;
		opened = item;
		return undefined;
	}

	/** Close the open item, if it is at `path`, without saving more. */
	function forget(path: string) {
		if (opened !== undefined && pathOf(opened) === path) {
			sessionOf(opened)?.release();
			openSequence += 1;
			opened = undefined;
		}
	}

	/** The capture a deletion or rename of a closed file acts on: the file as it is now. */
	async function captureNow(
		path: string,
	): Promise<Result<FileCapture, FileError>> {
		const { data: read, error } = await folder.files.read(path);
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
	}

	/** Whether the open item has a save running or a draft it could not save. */
	function unsaved() {
		const status = sessionOf(opened)?.state.status;
		return status === 'saving' || status === 'error';
	}

	/** The fields the list shows for `entry`: the open draft's when it is open. */
	function fieldsOf(entry: TodoEntry): TodoFields {
		return opened?.kind === 'todo' && opened.session.path === entry.path
			? opened.session.draft.fields
			: entry.row.fields;
	}

	/** Move a captured file: a todo row through its table, any other file as bytes. */
	function move(file: FileCapture, to: string) {
		const stem = rowStemOf(table.name, file.path);
		const nextStem = rowStemOf(table.name, to);
		return stem !== undefined && nextStem !== undefined
			? table.rename(file, nextStem)
			: folder.files.move(file, to);
	}

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		terminal,
		/** Rows that read as todos, as last listed. */
		get entries() {
			return entries;
		},
		/** Row files the list does not offer, with why; each opens as text for repair. */
		get repairs() {
			return repairs;
		},
		get listError() {
			return listError;
		},
		get listing() {
			return listing;
		},
		get listingError() {
			return listingError;
		},
		expanded,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/** The open item, or `undefined`. */
		get opened() {
			return opened;
		},
		/** The open item's path and the workspace that opened it. */
		get current() {
			return opened && { path: pathOf(opened), workspace: workspaceOf(opened) };
		},
		fieldsOf,
		/** Whether `path` is a todo row file, whether or not its text reads as a todo. */
		isTodo(path: string) {
			return rowPaths.has(path);
		},
		get unsaved() {
			return unsaved();
		},
		get saving() {
			return sessionOf(opened)?.state.status === 'saving';
		},
		get saveProblems() {
			return sessionOf(opened)?.state.status === 'error' ? 1 : 0;
		},
		get newTitle() {
			return newTitle;
		},
		set newTitle(title: string) {
			if (locked()) return;
			newTitle = title;
		},
		get departing() {
			return departing;
		},
		/** Whether a departure would lose anything: an unsaved draft, a typed title, or running work. */
		get holdsUnsaved() {
			return unsaved() || newTitle.trim() !== '' || operations.size > 0;
		},
		prepareDeparture() {
			departing = true;
		},
		/** Let running work and saves finish. Answers the path still holding a draft it could not save. */
		async drainDeparture(): Promise<readonly string[]> {
			await quiet();
			const session = sessionOf(opened);
			if (session === undefined) return [];
			const settled = await session.settled();
			return settled.status === 'error' ? [settled.file.path] : [];
		},
		resumeDeparture() {
			departing = false;
		},
		refresh,
		/** The person's "Check again", and returning to the window. */
		check,
		open,
		/**
		 * Reload theirs for `session`, the open item's: show the file as it is
		 * now. A todo whose text is no longer a valid row opens as text; a file
		 * that is gone closes. Answers what the person is told, if anything.
		 */
		async reloadTheirs(
			session: RowSession<TodoFields> | TextSession,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const item = opened;
			if (item === undefined || sessionOf(item) !== session) return undefined;
			if (item.kind === 'text') {
				const { data: found, error } = await admitted(item.session.reloadTheirs());
				if (error !== null) return describeError(error);
				if (found.kind === 'gone') forget(item.session.path);
				else if (found.kind === 'other') return NOT_TEXT;
				await refresh();
				return undefined;
			}
			if (item.kind !== 'todo') return undefined;
			const { data: found, error } = await admitted(item.session.reloadTheirs());
			if (error !== null) return describeError(error);
			if (opened !== item) return undefined;
			if (found.kind === 'gone') forget(item.session.path);
			else if (found.kind === 'other') {
				if (found.detail.name !== 'InvalidRow') return NOT_TEXT;
				item.session.release();
				opened = openText(found.detail, 'todos');
			}
			await refresh();
			return undefined;
		},
		/** Keep mine for `session`, the open item's: save the draft over the file, or create it again. */
		async keepMine(
			session: RowSession<TodoFields> | TextSession,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			if (sessionOf(opened) !== session) return undefined;
			const { error } = await admitted(session.keepMine());
			await refresh();
			return error === null ? undefined : describeError(error);
		},
		/** Discard the open item's draft and close it. Nothing is written. */
		discard() {
			if (opened !== undefined) forget(pathOf(opened));
		},
		async create(title: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const { data: created, error } = await admitted(
				table.create(
					{ fields: { title, done: false }, body: '' },
					{ stem: crypto.randomUUID() },
				),
			);
			if (error !== null) return describeError(error);
			if (newTitle.trim() === title) newTitle = '';
			await refresh();
			return (await open(created.path, 'todos')) === undefined
				? undefined
				: UNSAVED_STAYS;
		},
		/**
		 * Toggle completion to the opposite of what the list showed. The open
		 * todo takes it as an edit to its draft. A closed todo is replaced,
		 * guarded by the version the list read: one that changed since is
		 * refused, and the list reads it again.
		 */
		async toggle(entry: TodoEntry): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const done = !fieldsOf(entry).done;
			if (opened !== undefined && pathOf(opened) === entry.path) {
				if (opened.kind !== 'todo')
					return 'This todo is open as text, so change done there.';
				opened.session.edit((row) => {
					row.fields.done = done;
				});
				return undefined;
			}
			const { error } = await admitted(
				table.replace(entry, {
					fields: { ...entry.row.fields, done },
					body: entry.row.body,
				}),
			);
			await refresh();
			return error === null ? undefined : describeError(error);
		},
		/**
		 * Rename a file within its folder. A todo row renames through its table;
		 * any other file moves as exact bytes. The open item waits for its saves
		 * and moves from what its last save confirmed; a closed file moves from
		 * what it holds now. No other file moves with either.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			if (rowPaths.has(path) && rowStemOf(table.name, to) === undefined)
				return 'A todo file keeps its .md extension.';
			const session = sessionOf(opened);
			let moved: Result<unknown, Parameters<typeof describeError>[0]>;
			if (opened?.kind === 'todo' && rowStemOf(table.name, to) === undefined)
				moved = Err('A todo file keeps its .md extension.');
			else if (session?.path === path)
				moved = await admitted(session.rename((file) => move(file, to)));
			else {
				const { data: file, error } = await captureNow(path);
				moved = error !== null ? Err(error) : await admitted(move(file, to));
			}
			await refresh();
			return moved.error === null ? undefined : describeError(moved.error);
		},
		/** A new empty text file; it never replaces an existing one. */
		async createFile(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			const { error } = await admitted(folder.files.create(path, ''));
			if (error !== null) return describeError(error);
			await refresh();
			return (await open(path, 'files')) === undefined ? undefined : UNSAVED_STAYS;
		},
		async createFolder(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (
				listing?.directories.includes(path) ||
				listing?.files.some((file) => file.path === path)
			)
				return `"${name}" already exists here.`;
			const { error } = await admitted(folder.files.mkdir(path));
			if (error !== null) return describeError(error);
			if (directory !== '') expanded.add(directory);
			await refresh();
			return undefined;
		},
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * An open item's saves land first. Only empty folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const why = refused();
			if (why !== undefined) return Err(why);
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
			let file: FileCapture;
			const session = sessionOf(opened);
			if (session?.path === path) file = (await session.settled()).file;
			else {
				const { data, error } = await captureNow(path);
				if (error !== null) return Err(describeError(error));
				file = data;
			}
			const stem = rowStemOf(table.name, path);
			if (stem === undefined || !rowPaths.has(path))
				return Ok({ kind: 'file', ...file });
			const title =
				opened?.kind === 'todo' && opened.session.path === path
					? opened.session.draft.fields.title
					: entries.find((entry) => entry.path === path)?.row.fields.title;
			return Ok({
				kind: 'todo',
				...file,
				title: title?.trim() ? title : basename(path),
			});
		},
		/**
		 * Delete what was confirmed. The open item's session is released first
		 * and its last saves land, so the delete removes what this app saved
		 * last; a file another program changed since is refused.
		 */
		async remove(deletion: Deletion): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			let removed: Result<undefined, FileError | string>;
			if (deletion.kind === 'folder')
				removed = await admitted(folder.files.rmdir(deletion.path));
			else {
				const session = sessionOf(opened);
				let file: FileCapture = deletion;
				if (session?.path === deletion.path) {
					session.release();
					file = (await session.settled()).file;
				}
				removed = await admitted(
					deletion.kind === 'todo' ? table.delete(file) : folder.files.remove(file),
				);
				if (removed.error === null) forget(deletion.path);
				// The file stayed: open it again as it is now, in a new session.
				else if (session !== undefined && sessionOf(opened) === session)
					await open(deletion.path, workspaceOf(opened!), { discard: session });
			}
			await refresh();
			return removed.error === null ? undefined : describeError(removed.error);
		},
		/** Commit current saved files and push. */
		async commitAndPush(): Promise<CommitAndPushResult> {
			if (closing !== undefined)
				return { commit: { status: 'closed' }, push: { status: 'closed' } };
			if (departing)
				return {
					commit: { status: 'blocked', reason: DEPARTING },
					push: { status: 'skipped', reason: DEPARTING },
				};
			return admitted(folder.git.commitAndPush({ signal: leaving.signal }));
		},
		/** Fetch the remote's branch; nothing local changes. */
		async fetch(): ReturnType<TodosFolder['git']['fetch']> {
			if (closing !== undefined) return GitError.Closed();
			if (departing)
				return GitError.Failed({ operation: 'fetch', cause: DEPARTING });
			return admitted(folder.git.fetch({ signal: leaving.signal }));
		},
		/**
		 * Fetch, then apply the remote only as a clean fast-forward. A quit or
		 * restart asked for after the fetch withdraws the rest and says so.
		 */
		async pull(): Promise<Result<PullOutcome, PullError | GitError>> {
			if (closing !== undefined) return GitError.Closed();
			if (departing)
				return GitError.Failed({ operation: 'pull', cause: DEPARTING });
			return admitted(
				(async (): Promise<Result<PullOutcome, PullError | GitError>> => {
					const { error: fetchedError } = await folder.git.fetch({
						signal: leaving.signal,
					});
					if (closing !== undefined) return GitError.Closed();
					if (fetchedError) return Err(fetchedError);
					if (departing)
						return GitError.Failed({ operation: 'pull', cause: WITHDRAWN });
					const pulled = await folder.git.pullFastForward();
					await check();
					return pulled;
				})(),
			);
		},
		/**
		 * Fetch, then merge the remote into the saved, committed folder: a
		 * fast-forward when possible, otherwise one merge commit. Never pushes.
		 */
		async merge(): Promise<
			Result<MergeOutcome, MergeError | PullError | GitError>
		> {
			if (closing !== undefined) return GitError.Closed();
			if (departing)
				return GitError.Failed({ operation: 'merge', cause: DEPARTING });
			return admitted(
				(async (): Promise<
					Result<MergeOutcome, MergeError | PullError | GitError>
				> => {
					const { error: fetchedError } = await folder.git.fetch({
						signal: leaving.signal,
					});
					if (closing !== undefined) return GitError.Closed();
					if (fetchedError) return Err(fetchedError);
					if (departing)
						return GitError.Failed({ operation: 'merge', cause: WITHDRAWN });
					const merged = await folder.git.mergeIncoming();
					await check();
					return merged;
				})(),
			);
		},
		get recovering() {
			return recovering;
		},
		get lastRecovery() {
			return lastRecovery;
		},
		/**
		 * Recover the incoming update in `git.pendingIncoming`, only because the
		 * person asked. The open item's saves land first; a draft that could not
		 * save refuses, and nothing runs. While it runs the open item takes no
		 * input, and afterward it shows what the update left.
		 */
		async recoverIncoming(): Promise<RecoveryAttempt> {
			if (closing !== undefined)
				return { kind: 'ran', result: GitError.Closed() };
			if (departing || recovering) return { kind: 'busy' };
			recovering = true;
			return admitted(
				(async (): Promise<RecoveryAttempt> => {
					let attempt: RecoveryAttempt;
					try {
						const session = sessionOf(opened);
						const settled = await session?.settled();
						attempt =
							settled?.status === 'error'
								? { kind: 'unsettled', paths: [settled.file.path] }
								: { kind: 'ran', result: await folder.git.recoverIncoming() };
					} finally {
						recovering = false;
					}
					lastRecovery = { ...attempt, at: Date.now() };
					await check();
					return attempt;
				})(),
			);
		},
		/**
		 * Let running work and the open item's saves finish, then release the
		 * folder. A draft that could not save ends with the page; the
		 * completion names its path. Every call answers the same completion.
		 */
		close(): Promise<CloseOutcome> {
			if (closing !== undefined) return closing;
			const completion = Promise.withResolvers<CloseOutcome>();
			closing = completion.promise;
			leaving.abort();
			void (async (): Promise<CloseOutcome> => {
				await quiet();
				const settled = await sessionOf(opened)?.settled();
				const unsettled =
					settled?.status === 'error' ? [settled.file.path] : [];
				if (unsettled.length > 0)
					log.warn(
						new Error(
							`Closed with input that could not be saved, in ${unsettled.join(', ')}`,
						),
					);
				await folder.close();
				return Object.freeze({ unsettled: Object.freeze(unsettled) });
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	};
}
