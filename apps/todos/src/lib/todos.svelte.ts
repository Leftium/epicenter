/**
 * The Todos product state over one opened folder.
 *
 * Two observations refresh together after saves, terminal commands, pulls,
 * merges, and window focus: the todo rows in `todos/*.md`, and the folder listing the
 * file browser shows. The selection is a path. A todo row opens its todo
 * editor, one native row editor for its fields and its source, whether or
 * not its text reads as a todo; any other file opens as raw text, or as
 * details when it is not editable text. A path retains at most one opened
 * item, so a selection change never discards input and an operation on a
 * path settles the one editor there. Git status comes from the folder's
 * shared snapshot; this module adds no status cache of its own.
 *
 * The folder may be in this browser's storage, shared with other tabs, or a
 * directory the desktop host owns and other programs edit. Either folder
 * reports changed paths as hints; a hint rereads the listings and never
 * replaces what an editor holds. An open todo reads its file when it opens
 * and again only when the person reloads it; its writes replace whatever the
 * file holds. The terminal is the folder's own and ends with it.
 *
 * Closing fences the app from its first call: no action or terminal command
 * starts folder work after it, and nothing new is retained.
 */
import type {
	CommitAndPushResult,
	FileCapture,
	FileListing,
	GitSnapshot,
	MergeOutcome,
	MoveError,
	PullError,
	PullOutcome,
	RecoverOutcome,
	TableSnapshot,
	TableUpdateError,
	TableWriteError,
	TextCapture,
} from '@epicenter/folder';
import {
	FileError,
	GitError,
	MergeError,
	rowPath,
	rowStemOf,
} from '@epicenter/folder';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
} from '@epicenter/folder/file-browser';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import {
	createTextFileEditor,
	type SavedText,
	type TextFileEditor,
} from './editor.svelte.js';
import { nameProblem, readTextFile } from './files.js';
import type { TodosFolder } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';
import {
	BUSY,
	createTodoEditor,
	DEPARTING,
	describeReloadError,
	type TodoEditor,
} from './todo-editor.svelte.js';

const log = createLogger('todos');

export type Todos = ReturnType<typeof createTodos>;

/** A todo row as the table last listed it. */
export type TodoEntry = TableSnapshot<TodoFields>;

/** Whether a listed todo's text fails to parse or leaves a declared field with an issue. */
export function needsRepair(entry: TodoEntry): boolean {
	return entry.parseError !== undefined || entry.issues.length > 0;
}

/** A raw file the person opened. Todo rows open as todo editors instead. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: TextFileEditor }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

/** What a path retains while it is open: one todo editor or raw file. */
type Retained =
	| { readonly kind: 'todo'; readonly editor: TodoEditor }
	| OpenFile;

export type Selection =
	| { readonly kind: 'todo'; readonly editor: TodoEditor }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| { readonly kind: 'todo'; readonly entry: TodoEntry }
	| (FileCapture & { readonly kind: 'file' })
	| { readonly kind: 'folder'; readonly path: string };

/** What one explicit request to recover the pending incoming update did. */
export type RecoveryAttempt =
	/** Open editors hold input they could not save first; nothing ran. */
	| { readonly kind: 'unsettled'; readonly paths: readonly string[] }
	/** Another change to the folder was in progress; nothing ran. */
	| { readonly kind: 'busy' }
	| {
			readonly kind: 'ran';
			readonly result: Result<RecoverOutcome, PullError | GitError>;
	  };

/**
 * What the terminal close left unsettled: paths whose editors held input
 * that could not be saved, which ended with the page unchosen.
 */
export type CloseOutcome = { readonly unsettled: readonly string[] };

/** An open editor, held while an incoming update is recovered. */
type Held = Extract<Retained, { kind: 'todo' | 'text' }>;

/**
 * Hold each open editor in turn, then run `recover` only if every one
 * settled; otherwise answer the paths still holding input they could not
 * save. A todo fences its input before it waits for its writes, so nothing
 * it takes while a later editor settles can fail unseen, and once `recover`
 * ran it reads its row again before the fence lifts. A plain editor saves its
 * pending typing, then holds its saves at once; typing meanwhile saves
 * afterward against its baseline.
 */
async function recoverHeld(
	held: readonly Held[],
	recover: () => Promise<Result<RecoverOutcome, PullError | GitError>>,
	unsettled: readonly string[] = [],
): Promise<RecoveryAttempt> {
	const [first, ...rest] = held;
	if (first === undefined)
		return unsettled.length > 0
			? { kind: 'unsettled', paths: unsettled }
			: { kind: 'ran', result: await recover() };
	const next = (settled: boolean) =>
		recoverHeld(
			rest,
			recover,
			settled ? unsettled : [...unsettled, first.editor.path],
		);
	if (first.kind === 'text') {
		const settled = await first.editor.settle();
		return first.editor.hold(() => next(settled));
	}
	return first.editor.fence(async (settled) => {
		const attempt = await next(settled);
		// A todo that held unsaved input keeps it: only a recovery that ran
		// replaces what the todo shows.
		if (attempt.kind === 'ran') await first.editor.reload();
		return attempt;
	});
}

const UNSETTLED = 'Save or discard the open edits first.';
/** Why a pull or merge stopped after its fetch: Epicenter asked to leave meanwhile. */
const WITHDRAWN =
	'Epicenter asked to quit or restart after the fetch, so nothing was applied. Try again after it finishes or is cancelled.';
const CLOSING = 'Todos is closing, so nothing was changed.';

function editorOf(item: Retained | undefined) {
	return item?.kind === 'todo' || item?.kind === 'text'
		? item.editor
		: undefined;
}

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. Each names what is in the folder now: a refusal changed nothing, a move
 * that kept its source left both files, and a lost reply leaves the outcome
 * unknown. Nothing is retried or removed on the person's behalf.
 */
function describeWriteError(
	error: TableWriteError | FileError | MoveError,
): string {
	switch (error.name) {
		case 'Exists':
			return `"${basename(error.path)}" already exists here.`;
		case 'Conflict':
			return error.actualSha256 === undefined
				? 'The file is no longer here. Nothing was changed. Check it and try again.'
				: 'The file has different content now. Nothing was changed. Check it and try again.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'SourceNotRemoved':
			return `The file was copied to ${error.to}, but ${error.from} could not be removed, so the folder now has both. Open edits stay with ${error.from}. Delete whichever you do not want. ${error.cause.message}.`;
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. Check the file browser before trying again. ${error.message}`;
		default:
			return error.message;
	}
}

/** Why a toggle with no editor open changed nothing, or may not have. */
function describeUpdateError(error: TableUpdateError): string {
	switch (error.name) {
		case 'NotFound':
			return 'This todo is no longer in the folder.';
		case 'Unparsed':
			return 'This todo no longer reads as a todo, so nothing was changed. Open it and fix its source.';
		case 'UnsupportedSource':
			return `This todo's done value cannot be changed here: ${error.reason}. Change it in its source.`;
		default:
			return describeWriteError(error);
	}
}

export function createTodos(folder: TodosFolder) {
	const table = folder.tables.todos;
	let entries = $state.raw<TodoEntry[]>([]);
	let unreadable = $state.raw<{ path: string; message: string }[]>([]);
	let listError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	let git = $state.raw<GitSnapshot>(folder.git.snapshot);
	let selectedPath = $state<string | undefined>();
	let refreshSequence = 0;
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>(['todos']);
	const retained = new SvelteMap<string, Retained>();
	/**
	 * Paths a rename, delete, create, toggle, or reload is working on,
	 * claimed before its first await. What is retained there belongs to that
	 * operation until it releases: refreshes and opens leave it alone, and an
	 * overlapping operation on any of the same paths is refused. Other paths
	 * are unaffected. Each path maps to the promise its operation resolves on
	 * release, which is what `close` waits for.
	 */
	const reserved = new Map<string, Promise<void>>();
	/**
	 * The one completion every `close` call shares, set before anything else
	 * runs. Once set, no action starts, no path retains anything new, and a
	 * listing that answers late touches nothing.
	 */
	let closing: Promise<CloseOutcome> | undefined;
	/**
	 * Aborted the moment `close` starts. The app's own Git network waits take
	 * it (a fetch for Pull, Merge, or Fetch, and Commit and push), so close
	 * stops waiting for them at once; the operation then withdraws what was
	 * left, applying nothing, and closing the folder aborts the network work
	 * itself. Terminal commands do not take it: a local script runs to its
	 * last statement before the folder closes. A terminal `git fetch` or
	 * `git push` waits on the network inside the shell, bounded only by the
	 * shell's execution deadline (one hour, just-bash's default, which the
	 * folder's terminal does not change).
	 */
	const leaving = new AbortController();
	/**
	 * Set while an explicit recovery of the pending incoming update runs. It
	 * may write any path, so no path operation starts and no file opens until
	 * it settles; open todos refuse input, and plain editors keep typing,
	 * held from saving.
	 */
	let recovering = $state.raw<Promise<void> | undefined>();
	/**
	 * Opens past the recovery check that are still reading, until each has
	 * installed or dropped its editor. A recovery waits for these before it
	 * settles and holds the editors.
	 */
	const admitting = new Set<Promise<void>>();
	/**
	 * Operations admitted and not finished that hold no path: each Git
	 * command from its first step to its last, a recovery request, and each
	 * terminal command. Registered as they are admitted, before anything is
	 * awaited, so a departure's drain and `close` wait for all of them.
	 */
	const operations = new Set<Promise<unknown>>();

	/** Count `work` as running until it settles. */
	function admitted<T>(work: Promise<T>): Promise<T> {
		operations.add(work);
		const done = () => {
			operations.delete(work);
		};
		work.then(done, done);
		return work;
	}

	/**
	 * Wait until no path operation, admitted operation, or recovery runs. New
	 * ones are refused by the caller's fence, so this ends.
	 */
	async function quiet() {
		while (reserved.size > 0 || operations.size > 0 || recovering !== undefined)
			await Promise.allSettled([
				...reserved.values(),
				...operations,
				recovering,
			]);
	}
	/** The last explicit recovery request this session, kept on screen while the update is pending. */
	let lastRecovery = $state.raw<
		(RecoveryAttempt & { readonly at: number }) | undefined
	>();
	/**
	 * Epicenter asks to quit or restart. From `prepareDeparture` until
	 * `resumeDeparture`, no action, Git command, or terminal command starts,
	 * and every editor refuses input; writes already accepted go on. Nothing
	 * is closed or discarded, so a round that ends without leaving gives
	 * everything back as it was.
	 */
	let departing = $state(false);
	/**
	 * The title typed for a new todo and not yet added. It lives here, above
	 * the list that shows it, so a departure counts it and a cancelled round
	 * gives it back. Nothing creates a todo from it on its own.
	 */
	let newTitle = $state('');
	const rowPaths = $derived(new Set(entries.map((entry) => entry.path)));
	const selection = $derived.by((): Selection | undefined => {
		const path = selectedPath;
		const item = path === undefined ? undefined : retained.get(path);
		if (path === undefined || item === undefined) return undefined;
		return item.kind === 'todo' ? item : { kind: 'file', path, file: item };
	});
	const shell = folder.terminal();
	const terminal = createTerminalSession(
		{
			get cwd() {
				return shell.cwd;
			},
			// A command entered after close began answers as the closed folder
			// does; one entered while Epicenter asks to leave runs nothing.
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
						: // Only the caller's own signal: close waits for a local script
							// through its last statement before the folder closes.
							admitted(shell.exec(command, options)),
		},
		rereadFolder,
		// The session itself refuses typing, recall, and Enter meanwhile, so
		// its command, history, and output stay as they are.
		() => departing,
	);
	const unsubscribe = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	let rereading: Promise<void> | undefined;
	let rereadAgain = false;
	// Subscribed here, before the first read, so no change falls between them.
	// The folder hints this page's own saves too, so a todo editor's write
	// reaches the listings this way.
	const stopListening = folder.onFilesChanged(() => void reread());
	/**
	 * A text file editor's saves refresh the listings, so it can adopt what
	 * the folder holds now; the save never waits for it.
	 */
	const onSaved = () => void refresh();

	/**
	 * Reread after the folder hints that files changed, whoever changed them.
	 * Hints that arrive during a reread collapse into one more pass, so the
	 * last change is always read.
	 */
	function reread(): Promise<void> {
		if (closing !== undefined) return Promise.resolve();
		if (rereading !== undefined) {
			rereadAgain = true;
			return rereading;
		}
		rereading = (async () => {
			try {
				do {
					rereadAgain = false;
					await rereadFolder();
				} while (rereadAgain);
			} catch {
				// A failed reread keeps what is on screen; the next hint tries again.
			} finally {
				rereading = undefined;
			}
		})();
		return rereading;
	}

	function editors() {
		return [...retained.values()].flatMap((item) => editorOf(item) ?? []);
	}

	/**
	 * Claim paths for one operation; undefined when another operation holds
	 * any of them, or a recovery of an incoming update may write any path.
	 */
	function reserve(...paths: string[]) {
		if (recovering !== undefined) return undefined;
		if (paths.some((path) => reserved.has(path))) return undefined;
		const released = Promise.withResolvers<void>();
		for (const path of paths) reserved.set(path, released.promise);
		return () => {
			// A release frees only the paths this operation still owns.
			for (const path of paths)
				if (reserved.get(path) === released.promise) reserved.delete(path);
			released.resolve();
		};
	}

	/** Stop retaining a path. A todo editor's admitted saves still settle. */
	function forget(path: string) {
		const item = retained.get(path);
		if (item?.kind === 'todo') item.editor.release();
		else if (item?.kind === 'text') item.editor.dispose();
		retained.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/** Forget a path whose file is gone, unless its editor still holds input. */
	function forgetIdle(path: string) {
		const editor = editorOf(retained.get(path));
		if (editor === undefined || editor.isIdle) forget(path);
	}

	/** Retain a todo editor on `path`'s row, acquired just now. */
	function retainTodo(
		path: string,
		native: Parameters<typeof createTodoEditor>[1],
		rawMode = false,
	) {
		const editor = createTodoEditor(path, native, { rawMode });
		// Opened while Epicenter asks to leave: refusing like the rest.
		if (departing) editor.prepareDeparture();
		retained.set(path, { kind: 'todo', editor });
	}

	function sortEntries(list: readonly TodoEntry[]) {
		return [...list].sort((a, b) => {
			const doneA = a.fields.done === true ? 1 : 0;
			const doneB = b.fields.done === true ? 1 : 0;
			if (doneA !== doneB) return doneA - doneB;
			return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
		});
	}

	/**
	 * One listing pass. A stale pass, or one that answers after close began,
	 * stops before it touches state, and a pass speaks only for what was
	 * retained when it was requested and is not reserved by an operation now.
	 * Clean raw editors adopt newer saved text, and a path whose file left the
	 * folder is forgotten unless its editor still holds input. Open todos are
	 * not read: each reloads only when the person asks.
	 */
	async function refresh() {
		if (closing !== undefined) return;
		const sequence = ++refreshSequence;
		const stale = () => closing !== undefined || sequence !== refreshSequence;
		const requested = new Map(retained);
		const [
			{ data: rows, error: rowsError },
			{ data: files, error: filesError },
		] = await Promise.all([table.list(), folder.files.list()]);
		if (stale()) return;
		// Every row file that was read is a todo to select, whether or not its
		// text parses. A file that could not be read has no text to show.
		const read: TodoEntry[] = [];
		const failed: { path: string; message: string }[] = [];
		for (const {
			path,
			result: { data, error },
		} of rows ?? [])
			if (error === null) read.push(data);
			else failed.push({ path, message: error.message });
		if (rowsError) {
			// Keep the previous observation visible; never show an empty list for a failed read.
			listError = rowsError.message;
		} else {
			listError = undefined;
			entries = sortEntries(read);
			unreadable = failed;
		}
		if (filesError) listingError = filesError.message;
		else {
			listingError = undefined;
			listing = files;
		}
		const listed = new Map(read.map((entry) => [entry.path, entry]));
		const present = files && new Set(files.files.map((file) => file.path));
		const current = (path: string, item: Retained) =>
			retained.get(path) === item && !reserved.has(path);
		for (const [path, item] of requested) {
			// A raw editor's observation may have closed the app or started a
			// newer pass; nothing after that is forgotten, observed, or read.
			if (stale()) return;
			if (item.kind === 'loading' || !current(path, item)) continue;
			if (present && !present.has(path)) {
				forgetIdle(path);
				continue;
			}
			if (item.kind !== 'text') continue;
			const entry = listed.get(path);
			if (entry !== undefined) {
				item.editor.observe(entry);
				continue;
			}
			if (!present) continue;
			const { data: text } = await readTextFile(folder.files, path);
			if (stale()) return;
			if (text?.kind === 'text' && current(path, item))
				item.editor.observe(text.file);
		}
	}

	/** The listings and Git status: what a hint, a save, or a terminal command rereads. */
	async function rereadFolder() {
		if (closing !== undefined) return;
		await Promise.all([refresh(), folder.git.status()]);
	}

	/**
	 * Select a path. A todo row opens its todo editor, whether or not its
	 * text reads as a todo; any other file opens as raw text or details.
	 */
	async function open(path: string) {
		if (closing !== undefined) return;
		selectedPath = path;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		// A recovery may be writing this file; an editor opens on what it left.
		while (recovering !== undefined) await recovering;
		if (closing !== undefined || selectedPath !== path) return;
		// Registered with no await since the check above, so a recovery that
		// starts while this reads waits for its editor and then holds it too.
		const admission = admit(path);
		admitting.add(admission);
		try {
			await admission;
		} finally {
			admitting.delete(admission);
		}
	}

	/**
	 * Claim `path` and install what it opens as. Runs only inside `open`,
	 * registered in `admitting`, so no editor is ever installed while a
	 * recovery owns the folder's files without that recovery holding it.
	 */
	async function admit(path: string) {
		const known = retained.get(path);
		if (
			editorOf(known) !== undefined ||
			known?.kind === 'loading' ||
			reserved.has(path)
		)
			return;
		// This exact item is the claim on the path. A rename, delete, close, or
		// newer open forgets or replaces it, and a result that arrives after is
		// dropped. A result that arrives while an operation holds the path gives
		// the claim up: the operation decides what is retained there.
		const loading: Retained = { kind: 'loading' };
		retained.set(path, loading);
		const claimed = () => {
			if (retained.get(path) !== loading) return false;
			if (!reserved.has(path)) return true;
			retained.delete(path);
			return false;
		};
		const stem = rowStemOf(table.name, path);
		if (stem !== undefined) {
			// Malformed or schema-invalid text opens too, for repair. An editor
			// that is not retained holds nothing: acquisition stopped watching.
			const { data: opened, error } = await table.edit(stem);
			if (!claimed()) return;
			if (error === null) {
				retainTodo(path, opened);
				return;
			}
			// A todo row has one publisher, its row editor. A row that did not
			// open is shown as that failure, or as what its bytes are, and
			// opening it again retries; it never becomes a plain text editor,
			// even when a second read of the same file succeeds.
			if (error.name === 'InvalidUtf8') {
				const { data: read } = await readTextFile(folder.files, path);
				if (!claimed()) return;
				if (read !== null && read.kind !== 'text') {
					retained.set(path, read);
					return;
				}
			}
			retained.set(path, {
				kind: 'failed',
				message:
					error.name === 'NotFound'
						? 'This todo is no longer in the folder.'
						: error.message,
			});
			return;
		}
		const { data: read, error: readError } = await readTextFile(
			folder.files,
			path,
		);
		if (!claimed()) return;
		if (readError) {
			retained.set(path, { kind: 'failed', message: readError.message });
			return;
		}
		if (read.kind !== 'text') {
			retained.set(path, read);
			return;
		}
		const editor = createTextFileEditor(folder.files, read.file, onSaved);
		// Opened while Epicenter asks to leave: refusing like the rest.
		if (departing) editor.prepareDeparture();
		retained.set(path, { kind: 'text', editor });
	}

	/**
	 * The stem a table operation addresses: the path is a row the table
	 * listed, or a todo editor holds it.
	 */
	function rowStem(path: string): string | undefined {
		if (retained.get(path)?.kind !== 'todo' && !rowPaths.has(path))
			return undefined;
		return rowStemOf(table.name, path);
	}

	/**
	 * The row as the folder has it now, for a table operation to act on.
	 * `settled` is the version a raw draft last saved: a row that differs
	 * changed after that save, and the operation is refused.
	 */
	async function currentRow(
		stem: string,
		settled: string | undefined,
	): Promise<Result<TodoEntry, string>> {
		const { data: read, error: readError } = await table.get(stem);
		if (readError) return Err(readError.message);
		if (read === undefined) return Err('This todo is no longer in the folder.');
		if (settled !== undefined && read.sha256 !== settled)
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(read);
	}

	/**
	 * Move a raw file's exact bytes to an unoccupied path. `from` is the
	 * capture an editor last saved, or a path whose file is captured now.
	 */
	async function moveFile(
		from: FileCapture | string,
		to: string,
	): Promise<Result<FileCapture, string>> {
		let captured: FileCapture;
		if (typeof from === 'string') {
			const { data: read, error: readError } = await folder.files.read(from);
			if (readError) return Err(readError.message);
			captured = read;
		} else captured = from;
		const moved = await folder.files.move(captured, to);
		return moved.error ? Err(describeWriteError(moved.error)) : moved;
	}

	/**
	 * Rename an open todo's row. Its editor fences input and waits for
	 * admitted writes; a failed write refuses the rename and its input stays.
	 * The move is conditional on the row as it is after that, read now.
	 * Success acquires an editor at the destination and lets the source's go;
	 * nothing is written at either path meanwhile. A move whose reply was lost
	 * leaves the editor at the source and says so; a later write there of a
	 * row that did move fails as `NotFound`, recreating nothing.
	 */
	function renameTodo(
		item: { readonly kind: 'todo'; readonly editor: TodoEditor },
		stem: string,
		nextStem: string,
	): Promise<Result<undefined, string> | undefined> {
		const { editor } = item;
		const from = editor.path;
		const to = rowPath(table.name, nextStem);
		return editor.fence(async (settled) => {
			if (!settled) return undefined;
			const current = await currentRow(stem, undefined);
			if (current.error !== null) return current;
			const { error: renamedError } = await table.rename(stem, nextStem, {
				expectedSha256: current.data.sha256,
			});
			if (renamedError !== null) return Err(describeWriteError(renamedError));
			const { data: reopened, error: reopenedError } =
				await table.edit(nextStem);
			if (retained.get(from) === item) {
				editor.release();
				retained.delete(from);
			}
			// A destination that does not open as a todo is opened by path below.
			if (reopenedError === null && closing === undefined)
				retainTodo(to, reopened, editor.rawMode);
			return Ok(undefined);
		});
	}

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		terminal,
		get entries() {
			return entries;
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
		get selectedPath() {
			return selectedPath;
		},
		get selection() {
			return selection;
		},
		isTodo(path: string) {
			return rowPaths.has(path);
		},
		/** Whether any open editor has input that is not yet saved. */
		get unsaved() {
			return editors().some((editor) => !editor.isIdle);
		},
		get saving() {
			return editors().some((editor) => editor.isSaving);
		},
		get saveProblems() {
			return editors().filter((editor) => editor.hasProblem).length;
		},
		/** The title typed for a new todo, not yet added. Refused while Epicenter asks to leave. */
		get newTitle() {
			return newTitle;
		},
		set newTitle(title: string) {
			if (closing !== undefined || departing) return;
			newTitle = title;
		},
		/** Epicenter asks to quit or restart, and this page refuses input and actions. */
		get departing() {
			return departing;
		},
		/**
		 * Whether a departure would lose anything of the person's: input an
		 * editor has not saved, a new todo's typed title, or an operation still
		 * running. Nothing at all lets the page answer at once.
		 */
		get holdsUnsaved() {
			return (
				editors().some((editor) => !editor.isIdle) ||
				newTitle.trim() !== '' ||
				reserved.size > 0 ||
				operations.size > 0 ||
				recovering !== undefined ||
				admitting.size > 0
			);
		},
		/**
		 * Epicenter asks to quit or restart. At once, before anything is
		 * awaited: no action, Git command, or terminal command starts, and every
		 * editor refuses input. Writes already accepted go on. Nothing is closed,
		 * released, or discarded; `resumeDeparture` gives it all back.
		 */
		prepareDeparture() {
			departing = true;
			for (const editor of editors()) editor.prepareDeparture();
		},
		/**
		 * Let what is running finish, then have each editor save what its usual
		 * rules would save and wait for admitted saves. Answers the paths whose
		 * input is still not saved: a failed or unconfirmed save, a refused todo
		 * field, or a plain editor's conflict. Nothing is discarded; the new todo's typed title is
		 * never added on its own.
		 */
		async drainDeparture(): Promise<readonly string[]> {
			await quiet();
			while (admitting.size > 0) await Promise.all(admitting);
			const unsettled: string[] = [];
			for (const [path, item] of [...retained]) {
				const editor = editorOf(item);
				if (editor !== undefined && !(await editor.drainDeparture()))
					unsettled.push(path);
			}
			return unsettled;
		},
		/** The departure round ended without leaving: everything takes input again. */
		resumeDeparture() {
			departing = false;
			for (const editor of editors()) editor.resumeDeparture();
		},
		refresh,
		/**
		 * The person's "Check again", and returning to the window: the listings
		 * and Git status, joined with any reread a hint started. Open todos are
		 * not read; each reloads only when the person asks.
		 */
		check: reread,
		open,
		/**
		 * Explicitly discard a plain editor's input that cannot save. Nothing
		 * is written. A missing todo's Close explicitly discards its retained input.
		 */
		discard(path: string) {
			if (closing !== undefined || departing || reserved.has(path)) return;
			const item = retained.get(path);
			if (item?.kind === 'text' && item.editor.isDiscardable) forget(path);
			else if (
				item?.kind === 'todo' &&
				!item.editor.isFenced &&
				item.editor.editor.save.status === 'failed' &&
				item.editor.editor.save.error.name === 'NotFound'
			) {
				forget(path);
				selectedPath = path;
			}
		},
		/**
		 * The person's Reload of an open todo: once admitted writes settle,
		 * read the file and show it, replacing the todo's input, any failed
		 * save, and any refused field. A read that fails keeps the input, and so does input that
		 * arrives during the read. A missing file keeps the editor and its input. Answers what the person
		 * is told, if anything. Refused while the file is being renamed,
		 * deleted, or toggled.
		 */
		async reload(path: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (departing) return DEPARTING;
			const item = retained.get(path);
			if (item?.kind !== 'todo') return undefined;
			if (item.editor.isFenced) return BUSY;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			try {
				const { error } = await item.editor.reload();
				if (error === null) return undefined;
				return describeReloadError(error);
			} finally {
				release();
			}
		},
		async create(title: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (departing) return DEPARTING;
			const stem = crypto.randomUUID();
			const release = reserve(rowPath(table.name, stem));
			if (release === undefined) return BUSY;
			const { data: created, error: createdError } = await table
				.create({
					stem,
					fields: { title, done: false },
					body: '',
				})
				.finally(release);
			if (createdError) return describeWriteError(createdError);
			// The typed title is now a todo. Cleared here, not by the list, so a
			// departure that began meanwhile does not count it as unsent.
			if (newTitle.trim() === title) newTitle = '';
			await refresh();
			// The row was written; a closing app opens no editor for it.
			if (closing !== undefined) return undefined;
			await open(created.path);
			return undefined;
		},
		/**
		 * Toggle completion, to the opposite of what the list showed. An open
		 * todo takes it as `done` in the complete row on screen, written behind
		 * any write already admitted, so its latest title, notes, and unknown
		 * metadata stay; it is refused while that todo is edited as source or
		 * its writing waits for the person. Otherwise `done` is assigned in the
		 * row's text as it is now, and every other byte stays: other fields,
		 * unknown metadata, comments, quoting, and the notes. A `done` the list
		 * could not read is refused; so is text that no longer parses, or that
		 * cannot take the change without altering what it did not name. The
		 * source editor fixes those.
		 */
		async toggle(entry: TodoEntry): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (departing) return DEPARTING;
			const current = entry.fields.done;
			if (typeof current !== 'boolean')
				return 'This todo has no readable done value to change. Open it and fix its source.';
			const release = reserve(entry.path);
			if (release === undefined) return BUSY;
			const done = !current;
			let updated: Result<unknown, TableUpdateError>;
			try {
				const item = retained.get(entry.path);
				if (item?.kind === 'todo') return await item.editor.toggle(done);
				if (item?.kind === 'text')
					return 'This todo is open in its source editor. Change it there.';
				// The new value depends on nothing else in the row, so it is
				// assigned to whatever the row holds now; the publication is still
				// conditional on the bytes this call read.
				updated = await table.update(entry.stem, { fields: { done } }, {});
			} finally {
				release();
			}
			await refresh();
			return updated.error === null
				? undefined
				: describeUpdateError(updated.error);
		},
		/**
		 * Rename a file within its folder. A todo row renames through its table,
		 * which moves that one Markdown file; any other file moves as exact bytes,
		 * checked against the capture its editor saved or the one read now. No
		 * other file moves with either, whatever stem it shares.
		 *
		 * Both paths are reserved from this call until what was retained is at
		 * its new path. An open todo fences its input and settles its saves
		 * first, and a new todo editor opens at the destination; an open raw
		 * editor holds its saves while the file moves and saves again only at
		 * the new path.
		 *
		 * A move that put the file at the new path but could not remove the old
		 * one leaves both; the editor and its input stay at the old path, which
		 * still holds the file, and the answer names both paths.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (departing) return DEPARTING;
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			const stem = rowStem(path);
			const nextStem = rowStemOf(table.name, to);
			if (stem !== undefined && nextStem === undefined)
				return 'A todo file keeps its .md extension.';
			// A rename never lands on an open editor, clean or not.
			if (editorOf(retained.get(to)) !== undefined)
				return `"${name}" is open in an editor, so nothing was renamed.`;
			const release = reserve(path, to);
			if (release === undefined) return BUSY;
			const item = retained.get(path);
			let moved: Result<unknown, string> | undefined;
			/** The selection was on the file, at either path, when the rename landed. */
			let follow = false;
			try {
				if (stem !== undefined && nextStem !== undefined) {
					// Guarded by the capture's hash at the old path. What the new
					// path is given is that capture renamed, not a read of the
					// destination: a native folder checks the guard only as well
					// as other programs allow.
					const renameRow = async (capture: TextCapture) => {
						const { error: renamedError } = await table.rename(stem, nextStem, {
							expectedSha256: capture.sha256,
						});
						return renamedError
							? Err(describeWriteError(renamedError))
							: Ok({
									path: to,
									sha256: capture.sha256,
									text: capture.text,
								});
					};
					if (item?.kind === 'todo')
						moved = await renameTodo(item, stem, nextStem);
					else if (item?.kind === 'text')
						moved = await item.editor.move(renameRow);
					else {
						const current = await currentRow(stem, undefined);
						moved =
							current.error !== null ? current : await renameRow(current.data);
					}
				} else if (item?.kind === 'text')
					moved = await item.editor.move(async (settled: SavedText) => {
						const bytes = await moveFile(settled, to);
						return bytes.error === null
							? Ok({ ...bytes.data, text: settled.text })
							: bytes;
					});
				else moved = await moveFile(path, to);
				if (moved?.error === null) {
					follow = selectedPath === path || selectedPath === to;
					if (item?.kind === 'todo') {
						// The todo's editors were swapped inside its fence.
						if (selectedPath === path) selectedPath = to;
					} else if (
						item?.kind === 'text' &&
						retained.get(path) === item &&
						// A clean raw editor landing on a row gives way to the row's todo
						// editor. Typing that arrived during the move keeps the raw editor
						// and its save policy.
						!(nextStem !== undefined && item.editor.isIdle)
					) {
						// The reserved destination holds no editor: this replaces any
						// details or loading claim there.
						retained.delete(path);
						retained.set(to, item);
						if (selectedPath === path) selectedPath = to;
					} else if (item !== undefined && retained.get(path) === item)
						forget(path);
				}
			} finally {
				release();
			}
			if (moved === undefined) return UNSETTLED;
			await rereadFolder();
			if (moved.error !== null) return moved.error;
			if (follow && (selectedPath === undefined || selectedPath === to))
				await open(to);
			return undefined;
		},
		/** A new empty text file; it never replaces an existing one. */
		async createFile(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (departing) return DEPARTING;
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (listing?.directories.includes(path))
				return `"${name}" already exists here.`;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			const { error: createdError } = await folder.files
				.create(path, '')
				.finally(release);
			if (createdError) return describeWriteError(createdError);
			await rereadFolder();
			await open(path);
			return undefined;
		},
		async createFolder(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (departing) return DEPARTING;
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (
				listing?.directories.includes(path) ||
				listing?.files.some((file) => file.path === path)
			)
				return `"${name}" already exists here.`;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			const { error: madeError } = await folder.files
				.mkdir(path)
				.finally(release);
			if (madeError) return describeWriteError(madeError);
			if (directory !== '' && closing === undefined) expanded.add(directory);
			await refresh();
			return undefined;
		},
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * Pending typing is saved first; a draft that cannot save refuses, so no
		 * deletion discards input. Only empty folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			if (closing !== undefined) return Err(CLOSING);
			if (departing) return Err(DEPARTING);
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
			const release = reserve(path);
			if (release === undefined) return Err(BUSY);
			try {
				const stem = rowStem(path);
				const item = retained.get(path);
				const editor = editorOf(item);
				if (editor !== undefined && !(await editor.settle()))
					return Err(UNSETTLED);
				// A raw draft's saves are conditional, so its file must still be
				// the version it saved. A todo row is captured as it is now.
				const draft = item?.kind === 'text' ? item.editor.baseline : undefined;
				if (stem !== undefined) {
					const entry = await currentRow(stem, draft?.sha256);
					return entry.error !== null
						? entry
						: Ok({ kind: 'todo', entry: entry.data });
				}
				if (draft !== undefined)
					return Ok({ kind: 'file', path, sha256: draft.sha256 });
				const { data: read, error: readError } = await folder.files.read(path);
				if (readError) return Err(readError.message);
				return Ok({ kind: 'file', path, sha256: read.sha256 });
			} finally {
				release();
			}
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		async remove(deletion: Deletion): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (departing) return DEPARTING;
			if (deletion.kind === 'folder') {
				const release = reserve(deletion.path);
				if (release === undefined) return BUSY;
				const { error: removedError } = await folder.files
					.rmdir(deletion.path)
					.finally(release);
				await refresh();
				return removedError ? describeWriteError(removedError) : undefined;
			}
			const path =
				deletion.kind === 'todo' ? deletion.entry.path : deletion.path;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			let problem: string | undefined;
			try {
				const item = retained.get(path);
				const removeConfirmed = async (): Promise<
					Result<undefined, FileError>
				> => {
					try {
						return await (deletion.kind === 'todo'
							? table.delete(deletion.entry.stem, {
									expectedSha256: deletion.entry.sha256,
								})
							: folder.files.remove(deletion));
					} catch (cause) {
						return FileError.Unconfirmed({ path, operation: 'remove', cause });
					}
				};
				// An open editor owns the delete: its input is settled first and
				// none is accepted during it. The confirmation is modal, but a save
				// may have started or failed since the capture. A todo whose delete
				// reply was lost stays open, and the answer says so; a later write
				// of a row that is gone fails as `NotFound`, recreating nothing.
				let removed: Result<undefined, FileError> | undefined;
				if (item?.kind === 'todo')
					removed = await item.editor.fence(async (settled) =>
						settled ? removeConfirmed() : undefined,
					);
				else if (item?.kind === 'text')
					removed = await item.editor.remove(removeConfirmed);
				else removed = await removeConfirmed();
				if (removed === undefined) return UNSETTLED;
				if (removed.error) problem = describeWriteError(removed.error);
				// A raw draft that took typing during the delete stays, held, as a
				// draft of a removed file; so does a raw editor whose delete is
				// unknown.
				else if (retained.get(path) === item) forgetIdle(path);
			} finally {
				release();
			}
			await rereadFolder();
			return problem;
		},
		/** Commit current saved files and push. Unsaved editor input is not included. */
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
		/** Fetch the remote's branch; nothing local changes. Never runs on its own. */
		async fetch(): ReturnType<TodosFolder['git']['fetch']> {
			if (closing !== undefined) return GitError.Closed();
			if (departing)
				return GitError.Failed({ operation: 'fetch', cause: DEPARTING });
			return admitted(folder.git.fetch({ signal: leaving.signal }));
		},
		/**
		 * Fetch, then apply the remote only as a clean fast-forward. Never runs
		 * on its own. Admitted as one operation from the fetch to the refresh;
		 * a quit or restart asked for after the fetch withdraws the rest and
		 * says so, applying nothing.
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
					// A fetch that answers after close began, or that close stopped
					// waiting for, applies nothing.
					if (closing !== undefined) return GitError.Closed();
					if (fetchedError) return Err(fetchedError);
					if (departing)
						return GitError.Failed({ operation: 'pull', cause: WITHDRAWN });
					const pulled = await folder.git.pullFastForward();
					await refresh();
					return pulled;
				})(),
			);
		},
		/**
		 * Fetch, then merge the remote into the saved, committed folder: a
		 * fast-forward when possible, otherwise one merge commit. Never runs on
		 * its own and never pushes. Where the folder cannot merge, nothing is
		 * fetched. Admitted as one operation, like `pull`: a quit or restart
		 * asked for after the fetch withdraws the merge and says so.
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
					// A fetch that answers after close began, or that close stopped
					// waiting for, merges nothing.
					if (closing !== undefined) return GitError.Closed();
					if (fetchedError) return Err(fetchedError);
					if (departing)
						return GitError.Failed({ operation: 'merge', cause: WITHDRAWN });
					const merged = await folder.git.mergeIncoming();
					await refresh();
					return merged;
				})(),
			);
		},
		/** Whether an explicit recovery of the pending incoming update is running. */
		get recovering() {
			return recovering !== undefined;
		},
		/** The last recovery request this session, with when it was made. */
		get lastRecovery() {
			return lastRecovery;
		},
		/**
		 * Recover the incoming update in `git.pendingIncoming`, only because the
		 * person asked. Opening the folder, status checks, and refreshes report
		 * it and never resume it; nothing retries it.
		 *
		 * The update may write any file it changes, over what each open editor
		 * shows, so editors come first. From the first call no path operation
		 * starts and no file opens; a file still opening installs its editor
		 * first, so it is settled and held with the rest. Each editor saves its
		 * pending input under its usual rules and is held from then on: an open
		 * todo refuses input before it waits for its writes, and a plain editor
		 * holds its saves once they settle. If any still holds input it
		 * cannot save (a failed or unconfirmed save, a refused todo field, or a
		 * plain editor's conflict), nothing runs, their paths are answered, and
		 * every editor keeps its input. Otherwise they stay held while the
		 * folder recovers. Each todo reads its row again before its fence lifts and shows
		 * what the update left; a plain editor's typing saves afterward against
		 * its baseline, so a file the update changed comes back as a conflict.
		 * No editor saves while recovery runs. A failed reread keeps the previous
		 * input, which a later edit can save as a complete document.
		 *
		 * A refusal names the paths in neither state and writes nothing; the
		 * update stays pending until the person makes each one hold one of its
		 * states and asks again. Refused while another change is in progress.
		 */
		async recoverIncoming(): Promise<RecoveryAttempt> {
			if (closing !== undefined)
				return { kind: 'ran', result: GitError.Closed() };
			if (departing || recovering !== undefined || reserved.size > 0)
				return { kind: 'busy' };
			const finished = Promise.withResolvers<void>();
			// Set before anything is awaited; the whole request, its reread
			// included, is one admitted operation.
			recovering = finished.promise;
			return admitted(
				(async (): Promise<RecoveryAttempt> => {
					let attempt: RecoveryAttempt;
					try {
						// No open starts from here on; those already reading install
						// their editors first, so every editor is settled and held below.
						while (admitting.size > 0) await Promise.all(admitting);
						const held = [...retained.values()].filter(
							(item): item is Held =>
								item.kind === 'todo' || item.kind === 'text',
						);
						attempt = await recoverHeld(held, () =>
							folder.git.recoverIncoming(),
						);
					} finally {
						recovering = undefined;
						finished.resolve();
					}
					lastRecovery = { ...attempt, at: Date.now() };
					await rereadFolder();
					return attempt;
				})(),
			);
		},
		/**
		 * Save what can still be saved, then release the folder. This is the
		 * page's terminal teardown, not a choice about input: it runs when the
		 * mounted page is destroyed, which the view allows only while nothing
		 * is unsaved (or after the browser's leave confirmation, when the page
		 * ends anyway). Input that cannot save (a failed or unconfirmed save, a
		 * refused todo field, or a plain editor's conflict or lost delete reply) is neither saved nor
		 * replaced; it ends with the page, and the completion names its paths.
		 *
		 * Every call answers the same completion. From the first call no action
		 * starts, hints stop, and nothing new is retained. A rename, toggle, or
		 * delete that already owns its paths finishes first, so its editor
		 * settles where the operation left it. Each todo editor fences its
		 * input and waits for its admitted writes; raw editors finish their
		 * saves. Reads and preparation already
		 * running may finish later; their replies retain nothing. The folder
		 * closes its Git and storage resources.
		 */
		close(): Promise<CloseOutcome> {
			if (closing !== undefined) return closing;
			const completion = Promise.withResolvers<CloseOutcome>();
			// A save settled below may call close again; it gets this completion.
			closing = completion.promise;
			// The app's running Git network waits stop; terminal commands do not.
			leaving.abort();
			stopListening();
			unsubscribe();
			// An open that is still reading finds its claim gone and retains nothing.
			for (const [path, item] of retained)
				if (item.kind === 'loading') retained.delete(path);
			void (async (): Promise<CloseOutcome> => {
				// The fence stops new reservations and operations, so these are
				// all there will be. A recovery, Git command, or terminal command
				// already running finishes first, its last step included.
				await quiet();
				const unsettled: string[] = [];
				for (const [path, item] of retained) {
					let settled = true;
					if (item.kind === 'todo') settled = await item.editor.close();
					else if (item.kind === 'text') {
						settled = await item.editor.settle();
						item.editor.dispose();
					}
					if (!settled) unsettled.push(path);
				}
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
