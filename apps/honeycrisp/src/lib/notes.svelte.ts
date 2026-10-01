/**
 * The Honeycrisp product state over one opened notes folder.
 *
 * Three observations refresh together: note rows, folder rows, and the file
 * listing the file browser shows. They refresh after saves and terminal
 * commands, when the window regains focus, and when the host reports a change
 * made outside this page. Every open draft is told what the refresh found, so
 * a clean editor follows the file and a dirty one keeps its text.
 *
 * Drafts are retained per path. Selecting another note never discards one,
 * and rename, delete, and close settle or refuse instead of dropping input.
 */
import type {
	FileListing,
	FileVersion,
	GitSnapshot,
} from '@epicenter/app/files';
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
	createDraft,
	type Draft,
	type Observed,
	type SavedText,
} from './draft.svelte.js';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
	nameProblem,
	readTextFile,
} from './files.js';
import { applyFields } from './note-source.js';
import type { NotesHost } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Notes = ReturnType<typeof createNotes>;
export type FileEditor = Draft<SavedText | NoteEntry>;

/** A retained file opened by path, including notes. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: FileEditor }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

export type Selection =
	| {
			readonly kind: 'note';
			readonly editor: FileEditor;
			/** The listed row, or undefined when the file left the folder. */
			readonly entry: NoteEntry | undefined;
	  }
	| { readonly kind: 'file'; readonly path: string; readonly file: OpenFile };

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| { readonly kind: 'note'; readonly entry: NoteEntry }
	| {
			readonly kind: 'file';
			readonly path: string;
			readonly version: FileVersion;
	  }
	| { readonly kind: 'folder'; readonly path: string };

const UNSETTLED = 'Save or discard the open edits first.';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

/** Library errors state failures precisely; these are the ones a person acts on. */
function describeWriteError(error: {
	name: string;
	message: string;
	path?: string;
	expected?: unknown;
}): string {
	if (error.name === 'Conflict')
		return error.expected === 'absent'
			? `"${basename(error.path ?? '')}" already exists here.`
			: 'The file changed after it was read, so nothing was changed. Check it and try again.';
	if (error.name === 'DirectoryNotEmpty')
		return 'The folder is not empty, so nothing was deleted.';
	return error.message;
}

export function createNotes(host: NotesHost) {
	const { folder } = host;
	const notesTable = folder.tables.notes;
	const foldersTable = folder.tables.folders;

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
				editor: file.editor,
				entry: rows.find((entry) => entry.path === path),
			};
		return file && { kind: 'file', path, file };
	});

	const terminal = createTerminalSession(host.terminal, refreshAll);
	const unsubscribeGit = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	const unsubscribeChanges = host.onExternalChange(() => void refreshAll());

	function editorAt(path: string): FileEditor | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'text' ? file.editor : undefined;
	}

	function allEditors(): FileEditor[] {
		return [...openFiles.values()].flatMap((file) =>
			file.kind === 'text' ? [file.editor] : [],
		);
	}

	async function readNote(path: string): Promise<Observed<NoteEntry>> {
		const id = noteIdOf(path);
		if (id === undefined)
			return { kind: 'unreadable', message: `${path} is not a note file.` };
		try {
			const read = await notesTable.get(id);
			if (read.error)
				return { kind: 'unreadable', message: read.error.message };
			return read.data === undefined
				? { kind: 'removed' }
				: { kind: 'present', file: read.data };
		} catch (cause) {
			return {
				kind: 'unreadable',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}

	async function readText(path: string): Promise<Observed<SavedText>> {
		try {
			const read = await readTextFile(folder.files, path);
			if (read.error)
				return read.error.name === 'NotFound'
					? { kind: 'removed' }
					: { kind: 'unreadable', message: read.error.message };
			return read.data.kind === 'text'
				? { kind: 'present', file: read.data.file }
				: { kind: 'unreadable', message: 'The file is no longer text.' };
		} catch (cause) {
			return {
				kind: 'unreadable',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}

	/** A path owns one draft; its saved observation selects the write boundary. */
	function editorFor(initial: SavedText | NoteEntry): FileEditor {
		const existing = editorAt(initial.path);
		if (existing !== undefined) return existing;
		const editor = createDraft<SavedText | NoteEntry>(
			{
				async write(accepted, source) {
					if ('fields' in accepted)
						return notesTable.writeSource(accepted, source);
					const written = await folder.files.write(accepted.path, source, {
						expected: accepted.version,
					});
					return written.error
						? Err(written.error)
						: Ok({ path: accepted.path, source, version: written.data });
				},
				read: (path) =>
					noteIdOf(path) !== undefined ? readNote(path) : readText(path),
			},
			initial,
			{ onSaved: () => void refresh() },
		);
		openFiles.set(initial.path, { kind: 'text', editor });
		return editor;
	}

	function forget(path: string) {
		editorAt(path)?.dispose();
		openFiles.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	/** Retarget the retained file after a successful move or recovery write. */
	function retarget(from: string, to: string, saved?: NoteEntry): boolean {
		const file = openFiles.get(from);
		openFiles.delete(from);
		if (file?.kind === 'text') {
			file.editor.rebase(saved ?? { ...file.editor.accepted, path: to });
		}
		if (file !== undefined && file.kind !== 'loading') openFiles.set(to, file);
		const selected = selectedPath === from;
		if (selected) selectedPath = to;
		// An in-progress read still belongs to the old path. Reopen only a
		// loading selection; text drafts keep their identity and are not re-read here.
		return selected && file?.kind === 'loading';
	}

	async function refreshOnce() {
		const opened = [...openFiles].map(([path, file]) => ({
			path,
			file,
			accepted: file.kind === 'text' ? file.editor.accepted : undefined,
		}));
		let rows: Awaited<ReturnType<typeof notesTable.list>>;
		let folderRows: Awaited<ReturnType<typeof foldersTable.list>>;
		let files: Awaited<ReturnType<typeof folder.files.list>>;
		try {
			[rows, folderRows, files] = await Promise.all([
				notesTable.list(),
				foldersTable.list(),
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
		const present = new Map(notes.map((entry) => [entry.path, entry]));
		const broken = new Map(unreadable.map((item) => [item.path, item]));
		const paths = new Set(files.data?.files.map((file) => file.path));
		for (const { path, file, accepted } of opened) {
			if (openFiles.get(path) !== file) continue;
			if (file.kind === 'loading') continue;
			if (file.kind !== 'text') {
				if (!files.error && !paths.has(path)) openFiles.delete(path);
				continue;
			}
			if (file.editor.accepted !== accepted) continue;
			let observed: Observed<SavedText | NoteEntry>;
			if (noteIdOf(path) !== undefined) {
				if (rows.error) continue;
				const entry = present.get(path);
				const failed = broken.get(path);
				observed =
					entry !== undefined
						? { kind: 'present', file: entry }
						: failed !== undefined
							? { kind: 'unreadable', message: failed.message }
							: { kind: 'removed' };
			} else {
				if (files.error) continue;
				observed = paths.has(path) ? await readText(path) : { kind: 'removed' };
			}
			// The path may have been renamed or explicitly discarded during the read.
			if (openFiles.get(path) !== file || file.editor.accepted !== accepted)
				continue;
			if (file.editor.observe(observed) === 'gone') forget(path);
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

	/** Select a file without replacing any draft already retained for its path. */
	async function open(path: string) {
		selectedPath = path;
		focusRequest += 1;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const known = openFiles.get(path);
		if (known?.kind === 'text' || known?.kind === 'loading') return;
		// Identity, rather than the loading tag, keeps an old read from replacing
		// a newer open after rename, deletion, or an explicit discard.
		const loading: OpenFile = { kind: 'loading' };
		openFiles.set(path, loading);
		if (noteIdOf(path) !== undefined) {
			let entry = notes.find((item) => item.path === path);
			if (entry === undefined) {
				await refresh();
				entry = notes.find((item) => item.path === path);
			}
			const observed: Observed<NoteEntry> =
				entry !== undefined
					? { kind: 'present', file: entry }
					: await readNote(path);
			if (openFiles.get(path) !== loading) return;
			if (observed.kind === 'present') editorFor(observed.file);
			else
				openFiles.set(path, {
					kind: 'failed',
					message:
						observed.kind === 'removed'
							? 'This note is no longer in the folder.'
							: observed.message,
				});
			return;
		}
		const read = await readTextFile(folder.files, path).catch(
			(cause: unknown) => ({
				data: null,
				error: {
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		);
		if (openFiles.get(path) !== loading) return;
		if (read.error)
			openFiles.set(path, { kind: 'failed', message: read.error.message });
		else if (read.data.kind === 'text') editorFor(read.data.file);
		else openFiles.set(path, read.data);
	}

	/** The listed row for a path, read fresh when an editor does not hold it. */
	async function noteForOperation(
		path: string,
	): Promise<Result<NoteEntry, string>> {
		const editor = editorAt(path);
		if (editor !== undefined && !(await editor.settle())) return Err(UNSETTLED);
		const read = await readNote(path);
		if (read.kind === 'removed')
			return Err('This note is no longer in the folder.');
		if (read.kind === 'unreadable') return Err(read.message);
		return Ok(read.file);
	}

	/**
	 * Change a note's fields. An open editor receives the change in its draft,
	 * so it joins whatever is being typed instead of racing it.
	 */
	async function patchNote(
		path: string,
		fields: Partial<NoteFields>,
		{ save = 'now' }: { save?: 'now' | 'later' } = {},
	): Promise<string | undefined> {
		const editor = editorAt(path);
		if (editor !== undefined) {
			const patched = applyFields(editor.buffer, fields);
			if (patched.error !== null) {
				editor.refuse(patched.error);
				return patched.error;
			}
			editor.input(patched.data);
			if (save === 'later') return undefined;
			await editor.save();
			if (editor.phase === 'failed') return editor.failure;
			if (editor.phase === 'conflict')
				return 'The file changed elsewhere. Open the note to choose which version to keep.';
			return undefined;
		}
		const entry = notes.find((item) => item.path === path);
		if (entry === undefined) return 'This note is no longer in the folder.';
		try {
			const updated = await notesTable.update(entry, { fields });
			await refresh();
			return updated.error ? describeWriteError(updated.error) : undefined;
		} catch (cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
	}

	async function renameFile(
		from: string,
		to: string,
	): Promise<string | undefined> {
		const editor = editorAt(from);
		let expected: FileVersion;
		if (editor !== undefined) {
			if (!(await editor.settle())) return UNSETTLED;
			expected = editor.accepted.version;
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
		const reopen = retarget(from, to);
		await refreshAll();
		if (reopen) await open(to);
		return undefined;
	}

	/** Rename a note file: a new identity for the same note, moved through its table. */
	async function renameNoteFile(
		path: string,
		id: string,
	): Promise<string | undefined> {
		const target = await noteForOperation(path);
		if (target.error !== null) return target.error;
		const renamed = await notesTable.rename(target.data, id);
		if (renamed.error) {
			await refresh();
			return describeWriteError(renamed.error);
		}
		const reopen = retarget(path, renamed.data.path, renamed.data);
		await refresh();
		if (reopen) await open(renamed.data.path);
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
		/** The one retained text draft for an opened file. */
		editorAt,
		/** Drafts closing now would lose: typing, a running save, or a conflict. */
		get unsettled() {
			return allEditors().filter((editor) => editor.unsettled).length;
		},
		get saving() {
			return allEditors().some((editor) => editor.phase === 'saving');
		},
		get saveProblems() {
			return allEditors().filter(
				(editor) => editor.phase === 'failed' || editor.phase === 'conflict',
			).length;
		},
		refresh,
		refreshAll,
		open,
		/** Create a note in the folder being shown and open it. */
		async createNote(): Promise<string | undefined> {
			const at = now();
			try {
				const created = await notesTable.create({
					fields: {
						folderId: view.deleted ? null : view.folderId,
						title: '',
						pinned: false,
						createdAt: at,
						updatedAt: at,
						deletedAt: null,
					},
					body: '',
				});
				if (created.error) return describeWriteError(created.error);
				await refresh();
				editorFor(created.data);
				selectedPath = created.data.path;
				focusRequest += 1;
				return undefined;
			} catch (cause) {
				return cause instanceof Error ? cause.message : String(cause);
			}
		},
		patchNote,
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) => patchNote(path, { deletedAt: now() }),
		restoreNote: (path: string) => patchNote(path, { deletedAt: null }),
		async createFolder(name: string): Promise<string | undefined> {
			try {
				const created = await foldersTable.create({
					fields: { name, icon: null },
				});
				await refresh();
				return created.error ? describeWriteError(created.error) : undefined;
			} catch (cause) {
				return cause instanceof Error ? cause.message : String(cause);
			}
		},
		async patchFolder(
			entry: FolderEntry,
			fields: Partial<FolderFields>,
		): Promise<string | undefined> {
			try {
				const updated = await foldersTable.update(entry, { fields });
				await refresh();
				return updated.error ? describeWriteError(updated.error) : undefined;
			} catch (cause) {
				return cause instanceof Error ? cause.message : String(cause);
			}
		},
		/**
		 * Delete a folder after moving its notes out. A note that cannot be
		 * moved stops the operation before the folder goes, so it can be retried
		 * without leaving a note pointing at a folder that no longer exists.
		 */
		async deleteFolder(entry: FolderEntry): Promise<string | undefined> {
			const id = entry.stem;
			if (id === undefined) return 'This folder file has an unusable name.';
			for (const note of notes.filter((item) => item.fields.folderId === id)) {
				const problem = await patchNote(note.path, { folderId: null });
				if (problem !== undefined)
					return `A note could not be moved out of the folder: ${problem}`;
			}
			try {
				const fresh = await foldersTable.get(id);
				if (fresh.error) return fresh.error.message;
				if (fresh.data !== undefined) {
					const removed = await foldersTable.delete(fresh.data);
					if (removed.error) return describeWriteError(removed.error);
				}
			} catch (cause) {
				return cause instanceof Error ? cause.message : String(cause);
			}
			if (view.folderId === id) view = { ...view, folderId: null };
			await refresh();
			return undefined;
		},
		/**
		 * A draft whose file was removed or became unreadable: write it back as a
		 * note. The same path is used when it is free, so the note keeps its
		 * identity; otherwise it becomes a new note.
		 */
		async saveDraftAsNote(path: string): Promise<string | undefined> {
			const editor = editorAt(path);
			if (editor === undefined) return 'There is no draft to save.';
			try {
				let target = path;
				let written = await folder.files.write(target, editor.buffer, {
					expected: 'absent',
				});
				if (written.error?.name === 'Conflict') {
					target = notePath(newId());
					written = await folder.files.write(target, editor.buffer, {
						expected: 'absent',
					});
				}
				if (written.error) return describeWriteError(written.error);
				const saved = await readNote(target);
				if (saved.kind !== 'present')
					return 'The note was written but could not be read back.';
				retarget(path, target, saved.file);
				await refresh();
				return undefined;
			} catch (cause) {
				return cause instanceof Error ? cause.message : String(cause);
			}
		},
		/** Explicitly discard a draft whose file is gone or unreadable. */
		discardDraft(path: string) {
			const editor = editorAt(path);
			if (editor?.external !== undefined && editor.external.kind !== 'changed')
				forget(path);
		},
		/**
		 * Rename a file within its directory. A note file renames through its
		 * table; any other file moves as exact bytes, checked against the
		 * version its editor saw or the version read now.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			if (editorAt(to) !== undefined)
				return `A draft for "${name}" is still open. Save or discard it before renaming another file to this name.`;
			if (
				notePaths.has(path) ||
				(noteIdOf(path) !== undefined && editorAt(path) !== undefined)
			) {
				const id = noteIdOf(to);
				if (id === undefined) return 'A note file keeps its .md extension.';
				return renameNoteFile(path, id);
			}
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
		async createDirectory(
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
		 * deletion discards input. Only empty directories can be deleted.
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
			if (
				notePaths.has(path) ||
				(noteIdOf(path) !== undefined && editorAt(path) !== undefined)
			) {
				const entry = await noteForOperation(path);
				return entry.error !== null
					? entry
					: Ok({ kind: 'note', entry: entry.data });
			}
			const text = editorAt(path);
			if (text !== undefined) {
				if (!(await text.settle())) return Err(UNSETTLED);
				return Ok({ kind: 'file', path, version: text.accepted.version });
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
				deletion.kind === 'note' ? deletion.entry.path : deletion.path;
			// The confirmation is modal, but a save may have started or failed since the capture.
			const editor = editorAt(path);
			if (editor?.unsettled) return UNSETTLED;
			const removed =
				deletion.kind === 'note'
					? await notesTable.delete(deletion.entry)
					: await folder.files.remove(path, { expected: deletion.version });
			if (removed.error) {
				await refreshAll();
				return describeWriteError(removed.error);
			}
			forget(path);
			await refreshAll();
			return undefined;
		},
		/** Commit the saved files now. Unsaved editor input is not included. */
		commitNow: () => folder.git.commit(),
		/** Try to save every draft. Resolves how many still cannot be closed safely. */
		async settleAll(): Promise<number> {
			await Promise.all(allEditors().map((editor) => editor.settle()));
			return allEditors().filter((editor) => editor.unsettled).length;
		},
		async close() {
			for (const editor of allEditors()) {
				await editor.settle();
				editor.dispose();
			}
			unsubscribeGit();
			unsubscribeChanges();
			await host.close();
		},
	};
}
