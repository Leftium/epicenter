/**
 * The Todos product state over one opened folder.
 *
 * Two observations refresh together after saves, terminal commands, pulls,
 * and window focus: the todo rows in `todos/*.md`, and the folder listing the
 * file browser shows. The selection is a path. A todo row opens its todo
 * editor; any other file opens as raw text, or as details when it is not
 * editable text. A path retains at most one opened item, so a selection change
 * never discards a draft and an operation on a path settles the one editor
 * there. Git status comes from the folder's shared snapshot; this module adds
 * no status cache of its own.
 *
 * The folder may be in this browser's storage, shared with other tabs, or a
 * directory the desktop host owns and other programs edit. Either folder
 * reports changed paths as hints; a hint rereads through the same refresh and
 * never replaces what an editor holds. The terminal is the folder's own and
 * ends with it.
 *
 * Closing fences the app from its first call: no action or terminal command
 * starts folder work after it, and nothing new is retained.
 */
import type {
	CommitAndPushResult,
	FileCapture,
	FileListing,
	FileVersion,
	GitSnapshot,
	PullError,
	PullOutcome,
	TableWriteError,
} from '@epicenter/folder';
import { GitError, sameVersion } from '@epicenter/folder';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import {
	createTextFileEditor,
	createTodoEditor,
	patchTodo,
	type SavedText,
	stemOf,
	type TextFileEditor,
	type TodoEditor,
	type TodoEntry,
} from './editor.svelte.js';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
	nameProblem,
	readTextFile,
} from './files.js';
import type { TodosFolder } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Todos = ReturnType<typeof createTodos>;

/** A raw file the person opened. Todo rows open as todo editors instead. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: TextFileEditor }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

/** What a path retains while it is open: a todo editor or a raw file, never both. */
type Retained =
	| { readonly kind: 'todo'; readonly editor: TodoEditor }
	| OpenFile;

export type Selection =
	| {
			readonly kind: 'todo';
			readonly editor: TodoEditor;
			/** The listed row, or undefined when the file left the folder. */
			readonly entry: TodoEntry | undefined;
	  }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| { readonly kind: 'todo'; readonly entry: TodoEntry }
	| (FileCapture & { readonly kind: 'file' })
	| { readonly kind: 'folder'; readonly path: string };

const ROW_PATH = /^todos\/[^/]+\.md$/;
const UNSETTLED = 'Save or discard the open edits first.';
const BUSY =
	'Another change to this file is still in progress. Try again when it finishes.';
const CLOSING = 'Todos is closing, so nothing was changed.';

function editorOf(item: Retained | undefined) {
	return item?.kind === 'todo' || item?.kind === 'text'
		? item.editor
		: undefined;
}

/** Nothing typed is waiting, saving, or refused. */
function isIdle(editor: TodoEditor | TextFileEditor) {
	return !editor.dirty && editor.saveState.kind === 'saved';
}

/** Library errors state failures precisely; these are the ones a person acts on. */
function describeWriteError(error: TableWriteError): string {
	if (error.name === 'Conflict')
		return error.expected === 'absent'
			? `"${basename(error.path)}" already exists here.`
			: error.actual === undefined
				? 'The file is no longer here. Nothing was changed. Check it and try again.'
				: 'The file has different content now. Nothing was changed. Check it and try again.';
	if (error.name === 'DirectoryNotEmpty')
		return 'The folder is not empty, so nothing was deleted.';
	return error.message;
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
	 * Paths a rename, delete, create, or toggle is working on, claimed before
	 * its first await. What is retained there belongs to that operation until
	 * it releases: refreshes and opens leave it alone, and an overlapping
	 * operation on any of the same paths is refused. Other paths are unaffected.
	 * Each path maps to the promise its operation resolves on release, which is
	 * what `close` waits for.
	 */
	const reserved = new Map<string, Promise<void>>();
	/**
	 * The one completion every `close` call shares, set before anything else
	 * runs. Once set, no action starts, no path retains anything new, and a
	 * listing that answers late touches nothing.
	 */
	let closing: Promise<void> | undefined;
	const rowPaths = $derived(new Set(entries.map((entry) => entry.path)));
	const selection = $derived.by((): Selection | undefined => {
		const path = selectedPath;
		const item = path === undefined ? undefined : retained.get(path);
		if (path === undefined || item === undefined) return undefined;
		return item.kind === 'todo'
			? {
					kind: 'todo',
					editor: item.editor,
					entry: entries.find((entry) => entry.path === path),
				}
			: { kind: 'file', path, file: item };
	});
	const shell = folder.terminal();
	const terminal = createTerminalSession(
		{
			get cwd() {
				return shell.cwd;
			},
			// A command entered after close began answers as the closed folder does.
			exec: (command, options) =>
				closing === undefined
					? shell.exec(command, options)
					: Promise.resolve({
							stdout: '',
							stderr: 'The folder is closed\n',
							exitCode: 1,
						}),
		},
		refreshAll,
	);
	const unsubscribe = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	let rereading: Promise<void> | undefined;
	let rereadAgain = false;
	// Subscribed here, before the first read, so no change falls between them.
	const stopListening = folder.onFilesChanged(() => void reread());

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
					await refreshAll();
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

	/** Claim paths for one operation; undefined when another operation holds any of them. */
	function reserve(...paths: string[]) {
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

	function forget(path: string) {
		editorOf(retained.get(path))?.dispose();
		retained.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/** Forget a path whose file is gone, unless its editor still holds input. */
	function forgetIdle(path: string) {
		const editor = editorOf(retained.get(path));
		if (editor === undefined || isIdle(editor)) forget(path);
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
	 * Clean editors adopt newer saved text, and a path whose file left the
	 * folder is forgotten unless its editor still holds input.
	 */
	async function refresh() {
		if (closing !== undefined) return;
		const sequence = ++refreshSequence;
		const stale = () => closing !== undefined || sequence !== refreshSequence;
		const requested = new Map(retained);
		const [rows, files] = await Promise.all([
			table.list(),
			folder.files.list(),
		]);
		if (stale()) return;
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
		}
		if (files.error) listingError = files.error.message;
		else {
			listingError = undefined;
			listing = files.data;
		}
		const listed = new Map(
			rows.data?.entries.map((entry) => [entry.path, entry]),
		);
		const present =
			files.data && new Set(files.data.files.map((file) => file.path));
		const current = (path: string, item: Retained) =>
			retained.get(path) === item && !reserved.has(path);
		for (const [path, item] of requested) {
			// An editor's observation may have closed the app or started a newer
			// pass; nothing after that is forgotten, observed, or read.
			if (stale()) return;
			if (item.kind === 'loading' || !current(path, item)) continue;
			if (present && !present.has(path)) {
				forgetIdle(path);
				continue;
			}
			if (item.kind === 'todo') {
				const entry = listed.get(path);
				if (entry !== undefined) item.editor.observe(entry);
				continue;
			}
			if (item.kind !== 'text' || !present) continue;
			const read = await readTextFile(folder.files, path);
			if (stale()) return;
			if (read.data?.kind === 'text' && current(path, item))
				item.editor.observe(read.data.file);
		}
	}

	async function refreshAll() {
		if (closing !== undefined) return;
		await Promise.all([refresh(), folder.git.status()]);
	}

	/** Retain a todo editor for a row, unless an editor or an operation owns its path. */
	function retainTodo(entry: TodoEntry) {
		if (reserved.has(entry.path)) return;
		if (editorOf(retained.get(entry.path)) !== undefined) return;
		retained.set(entry.path, {
			kind: 'todo',
			editor: createTodoEditor(table, entry, () => void refresh()),
		});
	}

	/** Select a path: a todo row opens its editor, any other file opens as raw text or details. */
	async function open(path: string) {
		if (closing !== undefined) return;
		selectedPath = path;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const known = retained.get(path);
		if (
			known?.kind === 'todo' ||
			known?.kind === 'text' ||
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
		let entry = entries.find((item) => item.path === path);
		if (entry === undefined && ROW_PATH.test(path)) {
			// The list may predate a row written by the terminal or a pull.
			await refresh();
			if (!claimed()) return;
			entry = entries.find((item) => item.path === path);
		}
		if (entry !== undefined) {
			retainTodo(entry);
			return;
		}
		const read = await readTextFile(folder.files, path);
		if (!claimed()) return;
		retained.set(
			path,
			read.error
				? { kind: 'failed', message: read.error.message }
				: read.data.kind === 'text'
					? {
							kind: 'text',
							editor: createTextFileEditor(
								folder.files,
								read.data.file,
								() => void refresh(),
							),
						}
					: read.data,
		);
	}

	/** A row the table lists or a todo editor holds: its operations go through the table. */
	function isTableRow(path: string) {
		return rowPaths.has(path) || retained.get(path)?.kind === 'todo';
	}

	/**
	 * The row as the folder has it now, for a table operation to act on.
	 * `settled` is the version an open editor last saved: a row that differs
	 * changed after that save, and the operation is refused.
	 */
	async function currentRow(
		path: string,
		settled: FileVersion | undefined,
	): Promise<Result<TodoEntry, string>> {
		const read = await table.get(stemOf(path));
		if (read.error) return Err(read.error.message);
		if (read.data === undefined)
			return Err('This todo is no longer in the folder.');
		if (settled !== undefined && !sameVersion(read.data.version, settled))
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(read.data);
	}

	/** Rename a row through its table. Only the row's Markdown file moves. */
	async function renameRow(
		path: string,
		to: string,
		settled?: SavedText,
	): Promise<Result<TodoEntry, string>> {
		const row = await currentRow(path, settled?.version);
		if (row.error !== null) return row;
		const renamed = await table.rename(row.data, stemOf(to));
		return renamed.error ? Err(describeWriteError(renamed.error)) : renamed;
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
			const read = await folder.files.read(from);
			if (read.error) return Err(read.error.message);
			captured = read.data;
		} else captured = from;
		const moved = await folder.files.move(captured, to);
		return moved.error ? Err(describeWriteError(moved.error)) : moved;
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
			return editors().some((editor) => !isIdle(editor));
		},
		get saving() {
			return editors().some((editor) => editor.saveState.kind === 'saving');
		},
		get saveProblems() {
			return editors().filter(
				(editor) =>
					editor.saveState.kind === 'failed' ||
					editor.saveState.kind === 'conflict',
			).length;
		},
		refresh,
		refreshAll,
		open,
		/**
		 * Explicitly discard the input of an editor that cannot save: a failed
		 * save, or a conflict whose saved file is gone. Nothing is written; the
		 * path can be opened again as the folder has it now. Refused while the
		 * editor is saving or its file is being renamed or deleted.
		 */
		discard(path: string) {
			if (closing !== undefined || reserved.has(path)) return;
			const state = editorOf(retained.get(path))?.saveState;
			if (
				state?.kind === 'failed' ||
				(state?.kind === 'conflict' && state.current === undefined)
			)
				forget(path);
		},
		async create(title: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			const created = await table.create({
				fields: { title, done: false },
				body: '',
			});
			if (created.error) return describeWriteError(created.error);
			await refresh();
			// The row was written; a closing app opens no editor for it.
			if (closing !== undefined) return undefined;
			selectedPath = created.data.path;
			retainTodo(created.data);
			return undefined;
		},
		/** Toggle completion. An open editor receives it in its buffer instead of racing it. */
		async toggle(entry: TodoEntry): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			const release = reserve(entry.path);
			if (release === undefined) return BUSY;
			try {
				const editor = editorOf(retained.get(entry.path));
				const done = !(entry.fields.done === true);
				if (editor !== undefined) {
					if (!patchTodo(editor, { fields: { done } })) return editor.refusal;
					await editor.save();
					if (
						editor.saveState.kind === 'failed' ||
						editor.saveState.kind === 'conflict'
					)
						return editor.saveState.message;
					return undefined;
				}
				const updated = await table.update(stemOf(entry.path), {
					fields: { done } satisfies Partial<TodoFields>,
				});
				await refresh();
				return updated.error ? describeWriteError(updated.error) : undefined;
			} finally {
				release();
			}
		},
		/**
		 * Rename a file within its folder. A todo row renames through its table,
		 * which moves that one Markdown file; any other file moves as exact bytes,
		 * checked against the capture its editor saved or the one read now. No
		 * other file moves with either, whatever stem it shares.
		 *
		 * Both paths are reserved from this call until the retained editor is at
		 * its new path. The open editor owns the move: it settles its saves,
		 * holds new ones while the files move, and adopts the new path before
		 * saving again.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			const row = isTableRow(path);
			if (row && !ROW_PATH.test(to))
				return 'A todo file keeps its .md extension.';
			// A rename never lands on an open editor, clean or not.
			if (editorOf(retained.get(to)) !== undefined)
				return `"${name}" is open in an editor, so nothing was renamed.`;
			const release = reserve(path, to);
			if (release === undefined) return BUSY;
			const item = retained.get(path);
			const editor = editorOf(item);
			let moved: Result<unknown, string> | undefined;
			/** The selection was on the file, at either path, when the rename landed. */
			let follow = false;
			try {
				if (row)
					moved =
						editor === undefined
							? await renameRow(path, to)
							: await editor.move((settled: SavedText) =>
									renameRow(path, to, settled),
								);
				else if (item?.kind === 'text')
					moved = await item.editor.move(async (settled) => {
						const bytes = await moveFile(settled, to);
						return bytes.error === null
							? Ok({ ...bytes.data, source: settled.source })
							: bytes;
					});
				else moved = await moveFile(path, to);
				if (moved?.error === null) {
					follow = selectedPath === path || selectedPath === to;
					if (
						item !== undefined &&
						editor !== undefined &&
						retained.get(path) === item &&
						// A clean raw editor landing on a row gives way to the row's todo
						// editor. Typing that arrived during the move keeps the raw editor
						// and its save policy.
						!(item.kind === 'text' && ROW_PATH.test(to) && isIdle(editor))
					) {
						// The reserved destination holds no editor: this replaces any
						// details or loading claim there.
						retained.delete(path);
						retained.set(to, item);
						if (selectedPath === path) selectedPath = to;
					} else if (retained.get(path) === item) forget(path);
				}
			} finally {
				release();
			}
			if (moved === undefined) return UNSETTLED;
			await refreshAll();
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
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (listing?.directories.includes(path))
				return `"${name}" already exists here.`;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			const created = await folder.files.create(path, '').finally(release);
			if (created.error) return describeWriteError(created.error);
			await refreshAll();
			await open(path);
			return undefined;
		},
		async createFolder(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
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
				const row = isTableRow(path);
				const editor = editorOf(retained.get(path));
				if (editor !== undefined && !(await editor.settle()))
					return Err(UNSETTLED);
				if (row) {
					const entry = await currentRow(path, editor?.baseline.version);
					return entry.error !== null
						? entry
						: Ok({ kind: 'todo', entry: entry.data });
				}
				if (editor !== undefined)
					return Ok({ kind: 'file', path, version: editor.baseline.version });
				const read = await folder.files.read(path);
				if (read.error) return Err(read.error.message);
				return Ok({ kind: 'file', path, version: read.data.version });
			} finally {
				release();
			}
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		async remove(deletion: Deletion): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (deletion.kind === 'folder') {
				const removed = await folder.files.rmdir(deletion.path);
				await refresh();
				return removed.error ? describeWriteError(removed.error) : undefined;
			}
			const path =
				deletion.kind === 'todo' ? deletion.entry.path : deletion.path;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			let problem: string | undefined;
			try {
				// The confirmation is modal, but a save may have started or failed since the capture.
				const item = retained.get(path);
				const editor = editorOf(item);
				if (editor !== undefined && !isIdle(editor)) return UNSETTLED;
				const removed =
					deletion.kind === 'todo'
						? await table.delete(deletion.entry)
						: await folder.files.remove(deletion);
				if (removed.error) problem = describeWriteError(removed.error);
				// Typing that arrived during the delete stays as a draft of a removed file.
				else if (retained.get(path) === item) forgetIdle(path);
			} finally {
				release();
			}
			await refreshAll();
			return problem;
		},
		/** Commit current saved files and push. Unsaved editor input is not included. */
		async commitAndPush(): Promise<CommitAndPushResult> {
			if (closing !== undefined)
				return { commit: { status: 'closed' }, push: { status: 'closed' } };
			return folder.git.commitAndPush();
		},
		/** Fetch, then apply the remote only as a clean fast-forward. Never runs on its own. */
		async pull(): Promise<Result<PullOutcome, PullError | GitError>> {
			if (closing !== undefined) return GitError.Closed();
			const fetched = await folder.git.fetch();
			if (fetched.error) return Err(fetched.error);
			// A fetch that answers after close began applies nothing.
			if (closing !== undefined) return GitError.Closed();
			const pulled = await folder.git.pullFastForward();
			await refresh();
			return pulled;
		},
		/**
		 * Save what can still be saved, then release the folder. A draft that
		 * cannot save (a conflict or failure) ends with the page; the view asks
		 * before the page is left while any draft is unsaved.
		 *
		 * Every call answers the same completion. From the first call no action
		 * starts, hints stop, and nothing new is retained. A rename, toggle, or
		 * delete that already owns its paths finishes first, so its editor
		 * settles where the operation left it. Reads, single saves, terminal
		 * commands, and Git work already running are the folder's: it drains or
		 * cancels them when it closes, and what they answer late is dropped here.
		 */
		close() {
			if (closing !== undefined) return closing;
			const completion = Promise.withResolvers<void>();
			// A save settled below may call close again; it gets this completion.
			closing = completion.promise;
			stopListening();
			unsubscribe();
			// An open that is still reading finds its claim gone and retains nothing.
			for (const [path, item] of retained)
				if (item.kind === 'loading') retained.delete(path);
			void (async () => {
				// The fence stops new reservations, so these are all there will be.
				await Promise.all(reserved.values());
				for (const editor of editors()) {
					await editor.settle();
					editor.dispose();
				}
				await folder.close();
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	};
}
