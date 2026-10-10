/**
 * The learner's saved words, read from and saved to the folder's `entries`
 * table.
 *
 * The list is read when the page opens, after the app's own actions, and
 * when the learner returns to the window; the latest read wins. It offers the
 * files that read as words and names the rest, with why, for repair as text.
 *
 * One word is open at a time, in one edit session
 * (`@epicenter/svelte/edit-session`): a valid word is a row session over its
 * note and stage, and a file that is not a valid word is a text session over
 * its exact text. Leaving a word waits for its saves, then releases its
 * session and lists again. A save that failed or conflicted keeps the word
 * open until the learner discards it (`open` answers `unsaved`, and the view
 * asks). Returning to the window takes a newer version of the open word when
 * it holds nothing unsaved.
 *
 * A new word's file is named by the SHA-256 of its exact text, and creation
 * is exclusive, so two adds of one text reach the same file.
 */

import { InstantString } from '@epicenter/app/field';
import {
	type FileCapture,
	type FolderFiles,
	hashBytes,
	rowPath,
} from '@epicenter/folder';
import {
	createRowSession,
	createTextSession,
	type RowSession,
	type TextSession,
	wellFormed,
} from '@epicenter/svelte/edit-session';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type Entry,
	type EntryFields,
	readEntry,
	rowProblem,
	type Stage,
	type UnreadableFile,
	type VocabTables,
} from './data.js';

export const EntryError = defineErrors({
	Empty: () => ({ message: 'There is no text to save.' }),
	/** Another file is where this text's file belongs. Nothing was written. */
	Taken: ({ path }: { path: string }) => ({
		message: `A different file is already saved at '${path}', so this word was not added.`,
		path,
	}),
	/** The folder did not confirm the save. */
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This word was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;

/** The one open word: what its card, or its repair, shows. */
export type Opened =
	| { readonly kind: 'loading'; readonly id: string }
	| {
			readonly kind: 'word';
			readonly id: string;
			readonly session: RowSession<EntryFields>;
	  }
	| {
			readonly kind: 'text';
			readonly id: string;
			readonly session: TextSession;
	  }
	| { readonly kind: 'failed'; readonly id: string; readonly message: string };

/** A file in `entries/` that is not a valid word; `stem` is set when it can be repaired as text. */
export type Repair = UnreadableFile & { readonly stem?: string };

const CLOSED = 'This page is closing, so nothing was changed.';
/** Why Reload theirs showed nothing: the file is there but is not text. */
const NOT_TEXT =
	'This file is no longer text, so it cannot be shown here. Keep mine saves your version over it.';

/** What the learner is told about a failed change. */
export function describeError(error: {
	readonly name: string;
	readonly message: string;
}): string {
	if (error.name === 'Conflict')
		return 'actualSha256' in error && error.actualSha256 === undefined
			? 'This word’s file is gone, so nothing was changed.'
			: 'This word changed elsewhere, so nothing was changed. It has been read again.';
	if (error.name === 'InvalidValues' && 'issues' in error)
		return (error.issues as readonly { message: string }[])
			.map((issue) => issue.message)
			.join(' ');
	return error.message;
}

export function createEntriesState({
	table,
	files,
}: {
	table: VocabTables['entries'];
	files: FolderFiles;
}) {
	let rows = $state.raw<Entry[]>([]);
	let repairs = $state.raw<Repair[]>([]);
	let loadError = $state<string | null>(null);
	let opened = $state.raw<Opened | undefined>();
	let closed = false;
	let listSequence = 0;
	/** Advanced by every open, so a load that answers late installs nothing. */
	let openSequence = 0;
	/** Every saved entry, newest first. */
	const entries = $derived(
		rows.toSorted(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		),
	);

	const locked = () => closed;
	const sessionOf = (item: Opened | undefined) =>
		item?.kind === 'word' || item?.kind === 'text' ? item.session : undefined;

	async function refresh() {
		if (closed) return;
		const sequence = ++listSequence;
		const { data: listing, error } = await table.list();
		if (closed || sequence !== listSequence) return;
		if (error !== null) {
			// Keep what was listed; never show an empty list for a failed read.
			loadError = error.message;
			return;
		}
		const valid: Entry[] = [];
		const repair: Repair[] = [];
		for (const { stem, result } of listing) {
			if (result.error === null) valid.push(readEntry(stem, result.data));
			else if (result.error.name !== 'NotFound')
				repair.push({
					path: rowPath(table.name, stem),
					reason: rowProblem(result.error),
					// Text that is not a valid word is repaired as text; bytes that are not text are not.
					...(result.error.name === 'InvalidRow' ? { stem } : {}),
				});
		}
		rows = valid;
		repairs = repair;
		loadError = null;
	}

	/** List one word this page just saved, and drop any listing already under way. */
	function receive(entry: Entry) {
		listSequence++;
		rows = [...rows.filter(({ id }) => id !== entry.id), entry];
	}

	/** Wait for the open word's saves, then release it; false keeps it when a save failed and was not discarded. */
	async function leave(discard: unknown): Promise<boolean> {
		const session = sessionOf(opened);
		if (session === undefined) return true;
		const settled = await session.settled();
		if (settled.status === 'error' && discard !== session) return false;
		session.release();
		return true;
	}

	async function load(id: string): Promise<Opened> {
		const { data: stored, error } = await table.get(id);
		if (error?.name === 'InvalidRow')
			return {
				kind: 'text',
				id,
				session: createTextSession(files, error, { locked }),
			};
		if (error !== null) return { kind: 'failed', id, message: error.message };
		if (stored === undefined)
			return { kind: 'failed', id, message: 'This word’s file is gone.' };
		return {
			kind: 'word',
			id,
			session: createRowSession(table, stored, { locked }),
		};
	}

	/**
	 * Open the word at `id`: as its note and stage when it is a valid word,
	 * else as its exact text. The open word's saves land first and the list is
	 * read again. Answers `unsaved`, opening nothing, when the open word holds
	 * a draft it could not save; `discard` names the session the learner let go.
	 */
	async function open(id: string, { discard }: { discard?: unknown } = {}) {
		if (closed) return undefined;
		const sequence = ++openSequence;
		const left = opened;
		if (!(await leave(discard))) return 'unsaved' as const;
		if (left !== undefined) void refresh();
		if (sequence !== openSequence || closed) return undefined;
		opened = { kind: 'loading', id };
		const item = await load(id);
		if (sequence !== openSequence || closed) {
			sessionOf(item)?.release();
			return undefined;
		}
		opened = item;
		return undefined;
	}

	/** Close the open word, if it is `id`, without saving more. */
	function forget(id: string) {
		if (opened?.id !== id) return;
		sessionOf(opened)?.release();
		openSequence += 1;
		opened = undefined;
	}

	/** The open word's row session, if `id` is open as a word. */
	const wordSession = (id: string) =>
		opened?.kind === 'word' && opened.id === id ? opened.session : undefined;

	return {
		/** Every saved word, newest first, as last listed. */
		get entries() {
			return entries;
		},
		/** Files in `entries/` that are not valid words, with why. */
		get repairs() {
			return repairs;
		},
		/** Why the words could not be listed at all, until a listing succeeds. */
		get loadError() {
			return loadError;
		},
		/** The open word, or `undefined`. */
		get opened() {
			return opened;
		},
		/** Whether the open word has a save running or a draft it could not save. */
		get unsaved() {
			const status = sessionOf(opened)?.state.status;
			return status === 'saving' || status === 'error';
		},
		refresh,
		/** Returning to the window: list again, and take a newer version of the open word when it holds nothing unsaved. */
		async check() {
			await Promise.all([refresh(), sessionOf(opened)?.adopt()]);
		},
		open,
		/** The note and stage shown for `entry`: the open draft's when it is open. */
		fieldsOf(entry: Entry): EntryFields {
			return wordSession(entry.id)?.draft.fields ?? entry.stored.row.fields;
		},
		/** Whether a word with exactly this text is in the list as last read. */
		has(text: string) {
			return rows.some((entry) => entry.text === text);
		},

		/**
		 * Save a word or a captured phrase, and answer once the folder holds its
		 * file. The text is trimmed and otherwise exact. `present` means a word
		 * with that exact text is already saved and nothing was written. `note`
		 * starts empty and `stage` new: both are the learner's to set.
		 */
		async add(text: string): Promise<Result<'added' | 'present', EntryError>> {
			const exact = wellFormed(text.trim());
			if (exact === '') return EntryError.Empty();
			// A word under another name, such as one written outside Vocab, is
			// found by its text; each match is read before it is called present.
			for (const listed of rows.filter((entry) => entry.text === exact)) {
				const { data: current } = await table.get(listed.id);
				if (current?.row.fields.text === exact) return Ok('present');
			}
			const stem = await hashBytes(new TextEncoder().encode(exact));
			const { data: created, error } = await table.create(
				{
					fields: {
						text: exact,
						note: '',
						stage: 'new',
						createdAt: InstantString.now(),
					},
					body: '',
				},
				{ stem },
			);
			if (error === null) {
				receive(readEntry(stem, created));
				return Ok('added');
			}
			if (error.name !== 'Exists') return EntryError.NotSaved({ cause: error });
			// Another add, another tab, or an earlier attempt whose answer was
			// lost made the file. It is this word only if it holds this text.
			const { data: current, error: readError } = await table.get(stem);
			if (
				readError !== null &&
				readError.name !== 'InvalidRow' &&
				readError.name !== 'InvalidUtf8'
			)
				return EntryError.NotSaved({ cause: readError });
			if (current?.row.fields.text !== exact)
				return EntryError.Taken({ path: error.path });
			receive(readEntry(stem, current));
			return Ok('present');
		},

		/** Type the open word's note. */
		inputNote(id: string, note: string) {
			wordSession(id)?.edit((row) => {
				row.fields.note = wellFormed(note);
			});
		},

		/**
		 * Press a stage. The open word takes it as an edit to its draft. A closed
		 * word is replaced, guarded by the version the list read: one that changed
		 * since is refused, and the list reads it again. Answers what the learner
		 * is told, if anything.
		 */
		async setStage(entry: Entry, stage: Stage): Promise<string | undefined> {
			if (closed) return CLOSED;
			if (opened?.id === entry.id) {
				if (opened.kind !== 'word')
					return 'This word is open as text, so change its stage there.';
				opened.session.edit((row) => {
					row.fields.stage = stage;
				});
				return undefined;
			}
			const { row } = entry.stored;
			const { error } = await table.replace(entry.stored, {
				fields: { ...row.fields, stage },
				body: row.body,
			});
			await refresh();
			return error === null ? undefined : describeError(error);
		},

		/**
		 * Reload theirs for `session`, the open word's: show the file as it is
		 * now. A word whose text is no longer valid opens as text; a file that is
		 * gone closes. Answers what the learner is told, if anything.
		 */
		async reloadTheirs(
			session: RowSession<EntryFields> | TextSession,
		): Promise<string | undefined> {
			if (closed) return CLOSED;
			const item = opened;
			if (item === undefined || sessionOf(item) !== session) return undefined;
			const { data: found, error } = await session.reloadTheirs();
			if (error !== null) return describeError(error);
			if (opened !== item) return undefined;
			if (found.kind === 'gone') forget(item.id);
			else if (found.kind === 'other') {
				if (found.detail === 'binary' || found.detail.name !== 'InvalidRow')
					return NOT_TEXT;
				session.release();
				opened = {
					kind: 'text',
					id: item.id,
					session: createTextSession(files, found.detail, { locked }),
				};
			}
			await refresh();
			return undefined;
		},
		/** Keep mine for `session`, the open word's: save the draft over the file, or create it again. */
		async keepMine(
			session: RowSession<EntryFields> | TextSession,
		): Promise<string | undefined> {
			if (closed) return CLOSED;
			if (sessionOf(opened) !== session) return undefined;
			const { error } = await session.keepMine();
			await refresh();
			return error === null ? undefined : describeError(error);
		},

		/**
		 * Delete `entry`. The open word's session is released first and its last
		 * saves land, so the delete removes what this page saved last; a closed
		 * word is deleted only as the list showed it. A file changed elsewhere
		 * since is refused. Answers what the learner is told, if anything.
		 */
		async remove(entry: Entry): Promise<string | undefined> {
			if (closed) return CLOSED;
			const session = opened?.id === entry.id ? sessionOf(opened) : undefined;
			let file: FileCapture = entry.stored;
			if (session !== undefined) {
				session.release();
				file = (await session.settled()).file;
			}
			const { error } = await table.delete(file);
			if (error === null) forget(entry.id);
			// The file stayed: open it again as it is now, in a new session.
			else if (session !== undefined && sessionOf(opened) === session)
				await open(entry.id, { discard: session });
			await refresh();
			return error === null ? undefined : describeError(error);
		},

		/** Stop before the page releases its folder: the open word's saves land, and it is let go. */
		async close() {
			closed = true;
			const session = sessionOf(opened);
			await session?.settled();
			session?.release();
		},
	};
}

export type EntriesState = ReturnType<typeof createEntriesState>;
