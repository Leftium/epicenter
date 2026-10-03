/**
 * The Todos product state over one opened folder.
 *
 * Two observations refresh together after saves, terminal commands, pulls,
 * merges, and window focus: the todo rows in `todos/*.md`, and the folder listing the
 * file browser shows. The selection is a path. A todo row opens its
 * structured todo editor, or its source editor when the row cannot be edited
 * as fields; any other file opens as raw text, or as details when it is not
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
	FileError,
	FileListing,
	GitSnapshot,
	MergeOutcome,
	MoveError,
	PullError,
	PullOutcome,
	RecoverOutcome,
	TableEditError,
	TableSnapshot,
	TableWriteError,
	TextCapture,
} from '@epicenter/folder';
import { GitError, MergeError, rowPath, rowStemOf } from '@epicenter/folder';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import {
	createRowSourceEditor,
	createTextFileEditor,
	type SavedText,
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
import type { TodosFolder } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';
import {
	createTodoEditor,
	describeEditError,
	describeSaveError,
	type TodoEditor,
} from './todo-editor.svelte.js';

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

/**
 * A todo row's source editor. `reason` says why the row did not open as
 * fields when its text alone does not show it; it is undefined when the
 * person chose the source editor.
 */
type RowSource = {
	readonly kind: 'source';
	readonly editor: TextFileEditor;
	readonly reason: string | undefined;
};

/** What a path retains while it is open: one todo editor, row source editor, or raw file. */
type Retained =
	| { readonly kind: 'todo'; readonly editor: TodoEditor }
	| RowSource
	| OpenFile;

export type Selection =
	| { readonly kind: 'todo'; readonly editor: TodoEditor }
	| RowSource
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

/** Run `work` while every editor holds its saves. */
function holdAll<T>(
	held: readonly { hold<R>(work: () => Promise<R>): Promise<R> }[],
	work: () => Promise<T>,
): Promise<T> {
	const [first, ...rest] = held;
	return first === undefined ? work() : first.hold(() => holdAll(rest, work));
}

const UNSETTLED = 'Save or discard the open edits first.';
const BUSY =
	'Another change to this file is still in progress. Try again when it finishes.';
const CLOSING = 'Todos is closing, so nothing was changed.';

function editorOf(item: Retained | undefined) {
	return item?.kind === 'todo' ||
		item?.kind === 'source' ||
		item?.kind === 'text'
		? item.editor
		: undefined;
}

/** A row's source editor, opened because the row did not open as fields. */
function rowSource(
	editor: TextFileEditor,
	error: TableEditError | undefined,
): RowSource {
	return {
		kind: 'source',
		editor,
		// Parse failures and field issues show on the text itself.
		reason:
			error === undefined || error.name === 'InvalidSource'
				? undefined
				: describeEditError(error),
	};
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
			return 'The change was sent, but its reply was lost, so it may or may not have happened. Check the file browser before trying again.';
		default:
			return error.message;
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
	 * Paths a rename, delete, create, toggle, or editor switch is working on,
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
	let closing: Promise<void> | undefined;
	/**
	 * Set while an explicit recovery of the pending incoming update runs. It
	 * may write any path, so no path operation starts and no file opens until
	 * it settles; typing in open editors continues, held from saving.
	 */
	let recovering = $state.raw<Promise<void> | undefined>();
	/**
	 * Opens past the recovery check that are still reading, until each has
	 * installed or dropped its editor. A recovery waits for these before it
	 * settles and holds the editors.
	 */
	const admitting = new Set<Promise<void>>();
	/** The last explicit recovery request this session, kept on screen while the update is pending. */
	let lastRecovery = $state.raw<
		(RecoveryAttempt & { readonly at: number }) | undefined
	>();
	const rowPaths = $derived(new Set(entries.map((entry) => entry.path)));
	const selection = $derived.by((): Selection | undefined => {
		const path = selectedPath;
		const item = path === undefined ? undefined : retained.get(path);
		if (path === undefined || item === undefined) return undefined;
		return item.kind === 'todo' || item.kind === 'source'
			? item
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
	/** Every editor's saves refresh the listings; the save never waits for it. */
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

	function forget(path: string) {
		void editorOf(retained.get(path))?.dispose();
		retained.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/** Forget a path whose file is gone, unless its editor still holds input. */
	function forgetIdle(path: string) {
		const editor = editorOf(retained.get(path));
		if (editor === undefined || editor.isIdle) forget(path);
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
		// Every row file that was read is a todo to select, whether or not its
		// text parses. A file that could not be read has no text to show.
		const read: TodoEntry[] = [];
		const failed: { path: string; message: string }[] = [];
		for (const item of rows.data ?? [])
			if (item.result.error === null) read.push(item.result.data);
			else failed.push({ path: item.path, message: item.result.error.message });
		if (rows.error) {
			// Keep the previous observation visible; never show an empty list for a failed read.
			listError = rows.error.message;
		} else {
			listError = undefined;
			entries = sortEntries(read);
			unreadable = failed;
		}
		if (files.error) listingError = files.error.message;
		else {
			listingError = undefined;
			listing = files.data;
		}
		const listed = new Map(read.map((entry) => [entry.path, entry]));
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
				await item.editor.refresh();
				continue;
			}
			if (item.kind !== 'text' && item.kind !== 'source') continue;
			const entry = listed.get(path);
			if (entry !== undefined) {
				item.editor.observe(entry);
				continue;
			}
			if (item.kind !== 'text' || !present) continue;
			const text = await readTextFile(folder.files, path);
			if (stale()) return;
			if (text.data?.kind === 'text' && current(path, item))
				item.editor.observe(text.data.file);
		}
	}

	async function refreshAll() {
		if (closing !== undefined) return;
		await Promise.all([refresh(), folder.git.status()]);
	}

	/**
	 * Select a path. A todo row opens its todo editor, or its source editor
	 * when the row cannot be edited as fields; any other file opens as raw
	 * text or details.
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
			const opened = await table.edit(stem);
			if (!claimed()) {
				if (opened.error === null) void opened.data.dispose();
				return;
			}
			if (opened.error === null) {
				retained.set(path, {
					kind: 'todo',
					editor: createTodoEditor(table, opened.data, onSaved),
				});
				return;
			}
			const { error } = opened;
			if (error.name === 'NoCanonicalForm' || error.name === 'InvalidSource') {
				retained.set(
					path,
					rowSource(createRowSourceEditor(table, error.file, onSaved), error),
				);
				return;
			}
			// Absent, unreadable, or not text: the raw read below says which.
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
								onSaved,
							),
						}
					: read.data,
		);
	}

	/**
	 * The stem a table operation addresses: the path is a row the table
	 * listed, or an editor holds it as one.
	 */
	function rowStem(path: string): string | undefined {
		const kind = retained.get(path)?.kind;
		if (kind !== 'todo' && kind !== 'source' && !rowPaths.has(path))
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
		const read = await table.get(stem);
		if (read.error) return Err(read.error.message);
		if (read.data === undefined)
			return Err('This todo is no longer in the folder.');
		if (settled !== undefined && read.data.sha256 !== settled)
			return Err('The file changed after it was read. Check it and try again.');
		return Ok(read.data);
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
			return editors().some((editor) => !editor.isIdle);
		},
		get saving() {
			return editors().some((editor) => editor.isSaving);
		},
		get saveProblems() {
			return editors().filter((editor) => editor.hasProblem).length;
		},
		refresh,
		refreshAll,
		open,
		/**
		 * Explicitly discard the input of an editor that cannot save, or whose
		 * file changed elsewhere. Nothing is written. A todo whose file is still
		 * there but no longer reads as this draft reopens as the folder has it
		 * now, in its source editor when it no longer reads as a todo; any
		 * other path can be opened again. Refused while the editor's file is
		 * being renamed, deleted, or toggled.
		 */
		async discard(path: string): Promise<void> {
			if (closing !== undefined || reserved.has(path)) return;
			const item = retained.get(path);
			if (!editorOf(item)?.isDiscardable) return;
			// After the person's own delete, discarding closes the todo; what the
			// folder holds at the path is not taken as the delete's answer.
			const reopen =
				item?.kind === 'todo' &&
				item.editor.halt?.operation !== 'delete' &&
				item.editor.externalChange !== undefined &&
				item.editor.externalChange.kind !== 'missing';
			forget(path);
			if (reopen) await open(path);
		},
		async create(title: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			const stem = crypto.randomUUID();
			const release = reserve(rowPath(table.name, stem));
			if (release === undefined) return BUSY;
			const created = await table
				.create({
					stem,
					fields: { title, done: false },
					body: '',
				})
				.finally(release);
			if (created.error) return describeWriteError(created.error);
			await refresh();
			// The row was written; a closing app opens no editor for it.
			if (closing !== undefined) return undefined;
			await open(created.data.path);
			return undefined;
		},
		/**
		 * Toggle completion, to the opposite of what the list showed. An open
		 * todo editor takes it as a change to its draft and saves the whole
		 * draft. Otherwise a row editor opens on the row as it is now, changes
		 * `done`, saves, and is disposed. A row that cannot be edited as fields
		 * is refused; its source editor is how it is fixed.
		 */
		async toggle(entry: TodoEntry): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			const current = entry.fields.done;
			if (typeof current !== 'boolean')
				return 'This todo has no readable done value to change. Open it and fix its source.';
			const release = reserve(entry.path);
			if (release === undefined) return BUSY;
			const done = !current;
			try {
				const item = retained.get(entry.path);
				// A toggle is not the person's choice about a change made elsewhere,
				// or about a save, rename, or delete that failed or went unanswered.
				if (item?.kind === 'todo' && item.editor.isAwaitingReview)
					return 'This todo changed elsewhere. Choose whether to keep your edits in its editor first.';
				if (item?.kind === 'todo' && item.editor.halt !== undefined)
					return 'This todo has a change that is not settled. Choose what to do in its editor first.';
				if (item?.kind === 'todo')
					return (
						item.editor.change({ fields: { done } }) ??
						(await item.editor.save())
					);
				if (item?.kind === 'source' || item?.kind === 'text')
					return 'This todo is open in its source editor. Change it there.';
				const opened = await table.edit(entry.stem);
				if (opened.error !== null) return describeEditError(opened.error);
				const editor = opened.data;
				try {
					const changed = editor.change({ fields: { done } });
					if (changed.error !== null) return changed.error.message;
					const saved = await editor.save();
					return saved.error === null
						? undefined
						: describeSaveError(saved.error);
				} finally {
					await editor.dispose();
					await refresh();
				}
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
		 * holds new ones while the file moves, and saves again only at the new
		 * path. A todo editor reopens there; input typed meanwhile is kept.
		 *
		 * A move that put the file at the new path but could not remove the old
		 * one leaves both; the editor and its input stay at the old path, which
		 * still holds the file, and the answer names both paths.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
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
			/** What the destination retains, when it is not the moved item itself. */
			let landed: Retained | undefined;
			/** The selection was on the file, at either path, when the rename landed. */
			let follow = false;
			try {
				if (stem !== undefined && nextStem !== undefined) {
					const renameRow = async (capture: TextCapture) => {
						const renamed = await table.rename(capture, nextStem);
						return renamed.error
							? Err(describeWriteError(renamed.error))
							: renamed;
					};
					if (item?.kind === 'todo') {
						const result = await item.editor.move(nextStem);
						moved = result?.error
							? Err(describeWriteError(result.error))
							: result;
						if (result?.error === null && result.data.unopened !== undefined) {
							// The row moved but did not reopen as fields. Its unsaved
							// text stays, now in the row's source editor.
							const { row, unopened } = result.data;
							const source = createRowSourceEditor(table, row, onSaved);
							if (unopened.typed !== undefined) source.input(unopened.typed);
							landed = rowSource(source, unopened.error);
						}
					} else if (item?.kind === 'source' || item?.kind === 'text')
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
							? Ok({ ...bytes.data, source: settled.source })
							: bytes;
					});
				else moved = await moveFile(path, to);
				if (moved?.error === null) {
					follow = selectedPath === path || selectedPath === to;
					const editor = editorOf(item);
					if (
						item !== undefined &&
						editor !== undefined &&
						retained.get(path) === item &&
						// A clean raw editor landing on a row gives way to the row's todo
						// editor. Typing that arrived during the move keeps the raw editor
						// and its save policy.
						!(item.kind === 'text' && nextStem !== undefined && editor.isIdle)
					) {
						// The reserved destination holds no editor: this replaces any
						// details or loading claim there.
						retained.delete(path);
						retained.set(to, landed ?? item);
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
		/**
		 * Switch an open todo to its source editor, for text its fields do not
		 * edit, such as frontmatter the table does not declare. Pending input
		 * saves first; input that cannot save refuses the switch and stays.
		 */
		async editSource(path: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			const item = retained.get(path);
			const stem = rowStemOf(table.name, path);
			if (item?.kind !== 'todo' || stem === undefined) return undefined;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			try {
				if (!(await item.editor.settle())) return UNSETTLED;
				const row = await currentRow(stem, undefined);
				if (row.error !== null) return row.error;
				// Input typed while the row was read refuses the switch and stays.
				if (!item.editor.isIdle) return UNSETTLED;
				if (retained.get(path) !== item || closing !== undefined)
					return undefined;
				const disposing = item.editor.dispose();
				retained.set(
					path,
					rowSource(createRowSourceEditor(table, row.data, onSaved), undefined),
				);
				await disposing;
				return undefined;
			} finally {
				release();
			}
		},
		/**
		 * Switch a row's source editor back to its todo editor. The source saves
		 * first; text that does not open as fields stays in the source editor,
		 * with the reason.
		 */
		async editFields(path: string): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			const item = retained.get(path);
			const stem = rowStemOf(table.name, path);
			if (item?.kind !== 'source' || stem === undefined) return undefined;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			try {
				if (!(await item.editor.settle())) return UNSETTLED;
				const opened = await table.edit(stem);
				if (opened.error !== null) {
					if (retained.get(path) === item)
						retained.set(path, rowSource(item.editor, opened.error));
					return describeEditError(opened.error);
				}
				// Typing while the row opened keeps the source editor.
				if (
					retained.get(path) !== item ||
					!item.editor.isIdle ||
					closing !== undefined
				) {
					void opened.data.dispose();
					return item.editor.isIdle ? undefined : UNSETTLED;
				}
				item.editor.dispose();
				retained.set(path, {
					kind: 'todo',
					editor: createTodoEditor(table, opened.data, onSaved),
				});
				return undefined;
			} finally {
				release();
			}
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
			const release = reserve(path);
			if (release === undefined) return BUSY;
			const made = await folder.files.mkdir(path).finally(release);
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
				const stem = rowStem(path);
				const item = retained.get(path);
				const editor = editorOf(item);
				if (editor !== undefined && !(await editor.settle()))
					return Err(UNSETTLED);
				// A raw draft's saves are conditional, so its file must still be
				// the version it saved. A todo editor follows the file as it is.
				const draft =
					item?.kind === 'source' || item?.kind === 'text'
						? item.editor.baseline
						: undefined;
				if (stem !== undefined) {
					const entry = await currentRow(stem, draft?.sha256);
					return entry.error !== null
						? entry
						: Ok({ kind: 'todo', entry: entry.data });
				}
				if (draft !== undefined)
					return Ok({ kind: 'file', path, sha256: draft.sha256 });
				const read = await folder.files.read(path);
				if (read.error) return Err(read.error.message);
				return Ok({ kind: 'file', path, sha256: read.data.sha256 });
			} finally {
				release();
			}
		},
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		async remove(deletion: Deletion): Promise<string | undefined> {
			if (closing !== undefined) return CLOSING;
			if (deletion.kind === 'folder') {
				const release = reserve(deletion.path);
				if (release === undefined) return BUSY;
				const removed = await folder.files
					.rmdir(deletion.path)
					.finally(release);
				await refresh();
				return removed.error ? describeWriteError(removed.error) : undefined;
			}
			const path =
				deletion.kind === 'todo' ? deletion.entry.path : deletion.path;
			const release = reserve(path);
			if (release === undefined) return BUSY;
			let problem: string | undefined;
			try {
				const item = retained.get(path);
				const editor = editorOf(item);
				const removeConfirmed = () =>
					deletion.kind === 'todo'
						? table.delete(deletion.entry)
						: folder.files.remove(deletion);
				// An open editor owns the delete: a running save finishes first, no
				// save starts during it, and it records a lost reply before the path
				// is released. The confirmation is modal, but a save may have
				// started or failed since the capture.
				const removed =
					editor === undefined
						? await removeConfirmed()
						: await editor.remove(removeConfirmed);
				if (removed === undefined) return UNSETTLED;
				if (removed.error) problem = describeWriteError(removed.error);
				// Typing that arrived during the delete stays, held, as a draft of a
				// removed file; so does an editor whose delete is unknown.
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
		 * Fetch, then merge the remote into the saved, committed folder: a
		 * fast-forward when possible, otherwise one merge commit. Never runs on
		 * its own and never pushes. Where the folder cannot merge, nothing is
		 * fetched.
		 */
		async merge(): Promise<
			Result<MergeOutcome, MergeError | PullError | GitError>
		> {
			if (closing !== undefined) return GitError.Closed();
			const unsupported = folder.git.mergeUnsupported;
			if (unsupported !== undefined)
				return MergeError.Unsupported({ reason: unsupported });
			const fetched = await folder.git.fetch();
			if (fetched.error) return Err(fetched.error);
			// A fetch that answers after close began merges nothing.
			if (closing !== undefined) return GitError.Closed();
			const merged = await folder.git.mergeIncoming();
			await refresh();
			return merged;
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
		 * pending input under its
		 * usual rules; if any still holds input it cannot save (a halt, a review,
		 * a conflict, or fields that do not conform), nothing runs and their
		 * paths are answered. Then every editor holds its saves while the folder
		 * recovers, and each todo editor reads its row again before its hold
		 * lifts. A row the update changed is then another writer's change: a
		 * clean draft follows it, and input typed meanwhile waits for review. No
		 * editor saves over the update, and none takes it for a save of its own.
		 *
		 * A refusal names the paths in neither state and writes nothing; the
		 * update stays pending until the person makes each one hold one of its
		 * states and asks again. Refused while another change is in progress.
		 */
		async recoverIncoming(): Promise<RecoveryAttempt> {
			if (closing !== undefined)
				return { kind: 'ran', result: GitError.Closed() };
			if (recovering !== undefined || reserved.size > 0)
				return { kind: 'busy' };
			const finished = Promise.withResolvers<void>();
			recovering = finished.promise;
			let attempt: RecoveryAttempt;
			try {
				// No open starts from here on; those already reading install
				// their editors first, so every editor is settled and held below.
				while (admitting.size > 0) await Promise.all(admitting);
				const unsettled: string[] = [];
				for (const editor of editors())
					if (!(await editor.settle())) unsettled.push(editor.path);
				attempt =
					unsettled.length > 0
						? { kind: 'unsettled', paths: unsettled }
						: {
								kind: 'ran',
								result: await holdAll(editors(), () =>
									folder.git.recoverIncoming(),
								),
							};
			} finally {
				recovering = undefined;
				finished.resolve();
			}
			lastRecovery = { ...attempt, at: Date.now() };
			await refreshAll();
			return attempt;
		},
		/**
		 * Save what can still be saved, then release the folder. A draft that
		 * cannot save (a halted save, a conflict, or fields that do not
		 * conform) ends with the page; the view asks before the page is left
		 * while any draft is unsaved.
		 *
		 * Every call answers the same completion. From the first call no action
		 * starts, hints stop, and nothing new is retained. A rename, toggle, or
		 * delete that already owns its paths finishes first, so its editor
		 * settles where the operation left it. Editors finish their saves and
		 * are disposed before the folder closes. Reads and preparation already
		 * running may finish later; their replies retain nothing. The folder
		 * closes its Git and storage resources.
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
				// A recovery already running finishes and releases its holds first.
				await Promise.all([...reserved.values(), recovering]);
				for (const editor of editors()) {
					await editor.settle();
					await editor.dispose();
				}
				await folder.close();
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	};
}
