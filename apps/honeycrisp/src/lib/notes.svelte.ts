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
	TableWriteError,
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
export type NoteEditor = Draft<NoteEntry>;
export type TextFileEditor = Draft<SavedText>;

/** A raw file the person opened from the file browser. */
export type OpenFile =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'text'; readonly editor: TextFileEditor }
	| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };

export type Selection =
	| {
			readonly kind: 'note';
			readonly editor: NoteEditor;
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
	let refreshSequence = 0;
	let refreshing: Promise<void> | undefined;
	let refreshAgain = false;

	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([NOTES]);
	const editors = new SvelteMap<string, NoteEditor>();
	const openFiles = new SvelteMap<string, OpenFile>();
	const notePaths = $derived(new Set(notes.map((entry) => entry.path)));

	const selection = $derived.by((): Selection | undefined => {
		if (selectedPath === undefined) return undefined;
		const editor = editors.get(selectedPath);
		if (editor !== undefined)
			return {
				kind: 'note',
				editor,
				entry: notes.find((entry) => entry.path === selectedPath),
			};
		const file = openFiles.get(selectedPath);
		return file && { kind: 'file', path: selectedPath, file };
	});

	const terminal = createTerminalSession(host.terminal, refreshAll);
	const unsubscribeGit = folder.git.subscribe((snapshot) => {
		git = snapshot;
	});
	const unsubscribeChanges = host.onExternalChange(() => void refreshAll());

	function textEditorAt(path: string): TextFileEditor | undefined {
		const file = openFiles.get(path);
		return file?.kind === 'text' ? file.editor : undefined;
	}

	function allEditors(): (NoteEditor | TextFileEditor)[] {
		const all: (NoteEditor | TextFileEditor)[] = [...editors.values()];
		for (const file of openFiles.values())
			if (file.kind === 'text') all.push(file.editor);
		return all;
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
				: { kind: 'present', file: read.data as NoteEntry };
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

	function editorFor(entry: NoteEntry): NoteEditor {
		let editor = editors.get(entry.path);
		if (editor === undefined) {
			editor = createDraft<NoteEntry>(
				{
					write: async (accepted, source) => {
						const written = await notesTable.writeSource(accepted, source);
						return written.error
							? Err(written.error)
							: Ok(written.data as NoteEntry);
					},
					read: readNote,
				},
				entry,
				{ onSaved: () => void refresh() },
			);
			editors.set(entry.path, editor);
		}
		return editor;
	}

	function forget(path: string) {
		editors.get(path)?.dispose();
		editors.delete(path);
		const file = openFiles.get(path);
		if (file?.kind === 'text') file.editor.dispose();
		openFiles.delete(path);
		if (selectedPath === path) selectedPath = undefined;
	}

	async function observeOpenFiles(current: FileListing, sequence: number) {
		const present = new Set(current.files.map((file) => file.path));
		for (const [path, file] of openFiles) {
			if (sequence !== refreshSequence) return;
			if (file.kind === 'loading') continue;
			if (file.kind !== 'text') {
				if (!present.has(path)) openFiles.delete(path);
				continue;
			}
			const observed = present.has(path)
				? await readText(path)
				: ({ kind: 'removed' } as const);
			if (sequence !== refreshSequence) return;
			if (file.editor.observe(observed) === 'gone') forget(path);
		}
	}

	async function refreshOnce() {
		const sequence = ++refreshSequence;
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
		if (sequence !== refreshSequence) return;
		if (rows.error) {
			// Never show an empty list for a failed read.
			listError = rows.error.message;
		} else {
			listError = undefined;
			notes = rows.data.entries as NoteEntry[];
			unreadable = rows.data.unreadable.map((item) => ({
				path: item.path,
				message: item.error.message,
			}));
			const present = new Map(notes.map((entry) => [entry.path, entry]));
			const broken = new Map(unreadable.map((item) => [item.path, item]));
			for (const [path, editor] of editors) {
				const entry = present.get(path);
				const failed = broken.get(path);
				const outcome = editor.observe(
					entry !== undefined
						? { kind: 'present', file: entry }
						: failed !== undefined
							? { kind: 'unreadable', message: failed.message }
							: { kind: 'removed' },
				);
				if (outcome === 'gone') forget(path);
			}
		}
		if (!folderRows.error) folders = folderRows.data.entries as FolderEntry[];
		if (files.error) {
			listingError = files.error.message;
		} else {
			listingError = undefined;
			listing = files.data;
			await observeOpenFiles(files.data, sequence);
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

	/** Select a path: a note opens its editor, any other file opens as raw text or details. */
	async function open(path: string) {
		selectedPath = path;
		focusRequest += 1;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		const known = openFiles.get(path);
		if (
			editors.has(path) ||
			known?.kind === 'text' ||
			known?.kind === 'loading'
		)
			return;
		let entry = notes.find((item) => item.path === path);
		if (entry === undefined && noteIdOf(path) !== undefined) {
			// The list may predate a note written by the terminal or another program.
			await refresh();
			entry = notes.find((item) => item.path === path);
		}
		if (entry !== undefined) {
			editorFor(entry);
			return;
		}
		openFiles.set(path, { kind: 'loading' });
		const read = await readTextFile(folder.files, path).catch(
			(cause: unknown) => ({
				data: null,
				error: {
					message: cause instanceof Error ? cause.message : String(cause),
				},
			}),
		);
		if (openFiles.get(path)?.kind !== 'loading') return;
		openFiles.set(
			path,
			read.error
				? { kind: 'failed', message: read.error.message }
				: read.data.kind === 'text'
					? {
							kind: 'text',
							editor: createDraft<SavedText>(
								{
									async write(accepted, source) {
										const written = await folder.files.write(
											accepted.path,
											source,
											{ expected: accepted.version },
										);
										if (written.error) return Err(written.error);
										return Ok({
											path: accepted.path,
											source,
											version: written.data,
										});
									},
									read: readText,
								},
								read.data.file,
								// Raw writes request no commit; recheck so the change shows as uncommitted.
								{ onSaved: () => void refreshAll() },
							),
						}
					: read.data,
		);
	}

	/** The listed row for a path, read fresh when an editor does not hold it. */
	async function noteForOperation(
		path: string,
	): Promise<Result<NoteEntry, string>> {
		const editor = editors.get(path);
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
	): Promise<string | undefined> {
		const editor = editors.get(path);
		if (editor !== undefined) {
			const patched = applyFields(editor.buffer, fields);
			if (patched.error !== null) {
				editor.refuse(patched.error);
				return patched.error;
			}
			editor.input(patched.data);
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
		const editor = textEditorAt(from);
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
		const wasSelected = selectedPath === from;
		forget(from);
		await refreshAll();
		if (wasSelected) await open(to);
		return undefined;
	}

	/** Rename a note file: a new identity for the same note, moved through its table. */
	async function renameNoteFile(
		path: string,
		id: string,
	): Promise<string | undefined> {
		const editor = editors.get(path);
		const target = await noteForOperation(path);
		if (target.error !== null) return target.error;
		const renamed = await notesTable.rename(target.data, id);
		if (renamed.error) {
			await refresh();
			return describeWriteError(renamed.error);
		}
		if (editor !== undefined) {
			editors.delete(path);
			editor.rebase(renamed.data as NoteEntry);
			editors.set(renamed.data.path, editor);
		}
		if (selectedPath === path) selectedPath = renamed.data.path;
		await refresh();
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
		/** The retained editor for a note, when one is open. */
		editorAt(path: string): NoteEditor | undefined {
			return editors.get(path);
		},
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
		openNote(id: string) {
			return open(notePath(id));
		},
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
				editorFor(created.data as NoteEntry);
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
			const editor = editors.get(path);
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
				editors.delete(path);
				editor.rebase(saved.file);
				editors.set(target, editor);
				if (selectedPath === path) selectedPath = target;
				// A raw write requests no commit; this one is a managed save.
				void folder.git.commit();
				await refresh();
				return undefined;
			} catch (cause) {
				return cause instanceof Error ? cause.message : String(cause);
			}
		},
		/** Explicitly discard a draft whose file is gone or unreadable. */
		discardDraft(path: string) {
			const editor = editors.get(path) ?? textEditorAt(path);
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
			if (notePaths.has(path) || editors.has(path)) {
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
			if (editors.has(path) || notePaths.has(path)) {
				const entry = await noteForOperation(path);
				return entry.error !== null
					? entry
					: Ok({ kind: 'note', entry: entry.data });
			}
			const text = textEditorAt(path);
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
			const editor = editors.get(path) ?? textEditorAt(path);
			if (editor?.unsettled) return UNSETTLED;
			const removed =
				deletion.kind === 'note'
					? await notesTable.delete(deletion.entry)
					: await folder.files.remove(path, { expected: deletion.version });
			if (removed.error) {
				await refreshAll();
				return describeWriteError(removed.error as TableWriteError);
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
