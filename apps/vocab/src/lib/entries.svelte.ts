/**
 * The learner's saved words, read from and saved to the folder's `entries`
 * table.
 *
 * What is listed is what the folder has answered for: a word appears once
 * its file's receipt arrives, and an edit is listed once its saves land and
 * the file is read. Notes and stages are edited through one row editor per
 * word (see `word.svelte.ts`), opened when the word's card is shown and kept
 * here, above every view of that word; its saves write the whole word.
 * Reading the list again never reloads an open word's editor. A removal is
 * fixed to the version shown when the learner asked, and made against a
 * capture read once the word's saves have settled, only when that capture is
 * that version; a word that changed elsewhere is refused and read again.
 *
 * A new word's file is named by the SHA-256 of its exact text, and creation
 * is exclusive. Two adds of one text, in one tab or two, or a retry after an
 * answer that never arrived, therefore reach the same file: one creates it
 * and the others find it, with its note and stage as they are.
 */

import { InstantString } from '@epicenter/app/field';
import { hashBytes, inspectRow } from '@epicenter/folder';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type Entry,
	readEntry,
	readRows,
	type UnreadableFile,
	type VocabTables,
	vocabFolder,
} from './data.js';
import { createReread } from './reread.js';
import { createWord, type Word } from './word.svelte.js';

export const EntryError = defineErrors({
	Empty: () => ({ message: 'There is no text to save.' }),
	/** The file differs from what was read here. Nothing was written. */
	Changed: () => ({
		message:
			'This word changed since it was shown here, so the change was not saved.',
	}),
	/** Another file is where this text's file belongs. Nothing was written. */
	Taken: ({ path }: { path: string }) => ({
		message: `A different file is already saved at '${path}', so this word was not added.`,
		path,
	}),
	/** A delete was sent and its answer was lost: the word may or may not be gone. */
	Unconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `The delete was sent, but no answer came back, so whether this word is gone is not known: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** Another delete or a restoration of this word is under way. Nothing was sent. */
	Busy: () => ({
		message:
			'This word is busy with another change. Nothing was deleted; try again once it finishes.',
	}),
	/** The words list is closing with the page. Nothing was read or deleted. */
	Closed: () => ({
		message: 'This page is closing, so the word was not deleted.',
	}),
	/** The folder did not confirm the save. */
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This word was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;

export function createEntriesState({
	table,
}: {
	table: VocabTables['entries'];
}) {
	let rows = $state.raw<Entry[]>([]);
	let unreadable = $state.raw<UnreadableFile[]>([]);
	let loadError = $state<string | null>(null);
	/** Every saved entry, newest first. */
	const entries = $derived(
		rows.toSorted(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		),
	);

	// Counts receipts. A listing asked for before a receipt may not hold that
	// save, so it is not applied; the folder is read again instead, which keeps
	// whatever else that listing held, such as another tab's new word.
	let receipts = 0;
	// One removal at a time per word, so each is made against the capture the
	// one before it left.
	const queues = new Map<string, Promise<unknown>>();
	/** The editors of words opened on this page, kept while they are needed. */
	const words = new Map<string, Word>();

	const refresh = createReread(async () => {
		const before = receipts;
		const { data: listing, error: listError } = await table.list();
		if (before !== receipts) return false;
		if (listError !== null) {
			loadError = listError.message;
			return true;
		}
		const read = readRows(listing, readEntry);
		const ids = new Set(read.rows.map((entry) => entry.id));
		// A word removed elsewhere stays listed while its save is running or
		// failed, or its delete is unanswered, so the learner sees their text
		// until they let it go. Nothing writes the word back. Otherwise its
		// editor goes.
		const kept = rows.filter(
			(entry) => !ids.has(entry.id) && words.get(entry.id)?.unsettled,
		);
		for (const [id, word] of words)
			if (!ids.has(id) && !word.unsettled) {
				words.delete(id);
				void word.close();
			}
		rows = [...read.rows, ...kept];
		unreadable = read.unreadable;
		loadError = null;
		return true;
	});

	function receive(id: string, next: Entry | undefined) {
		receipts++;
		const others = rows.filter((entry) => entry.id !== id);
		rows = next ? [...others, next] : others;
	}

	const has = (text: string) => rows.some((entry) => entry.text === text);

	/** Run one removal of a word after the one before it has settled. */
	function queued<T>(id: string, step: () => Promise<T>): Promise<T> {
		const next = (queues.get(id) ?? Promise.resolve()).then(step, step);
		queues.set(id, next);
		const release = () => {
			if (queues.get(id) === next) queues.delete(id);
		};
		void next.then(release, release);
		return next;
	}

	/**
	 * Read the word's file now and list what it holds. A word whose file is
	 * gone leaves the list unless its save is running or failed.
	 */
	async function relist(id: string): Promise<void> {
		const { data: current, error: readError } = await table.get(id);
		if (readError !== null) return;
		const entry = current && readEntry(current);
		if (entry !== undefined) receive(id, entry);
		else if (current === undefined && !words.get(id)?.unsettled)
			receive(id, undefined);
	}

	/**
	 * Delete the word's file as it is now, only when that is what the learner
	 * chose: `listed`, the capture the list showed when they pressed Delete,
	 * or `shown`, the exact text the word's editor held once its own admitted
	 * saves settled. Nothing read from elsewhere since can stand in for them.
	 * The file is read after the word's saves settled, and the delete is
	 * conditional on exactly that read.
	 */
	async function deleteChosen(
		id: string,
		listed: Entry['file'],
		shown: string | undefined,
	): Promise<Result<undefined, EntryError>> {
		const { data: current, error: readError } = await table.get(id);
		if (readError !== null) return EntryError.NotSaved({ cause: readError });
		// Already removed elsewhere: the word is gone, which is what was asked.
		if (current === undefined) return Ok(undefined);
		if (current.sha256 !== listed.sha256 && current.text !== shown)
			return EntryError.Changed();
		const { error: deleteError } = await table.delete(id, {
			expectedSha256: current.sha256,
		});
		// Already removed elsewhere: the word is gone, which is what was asked.
		const gone =
			deleteError?.name === 'NotFound' ||
			(deleteError?.name === 'Conflict' &&
				deleteError.actualSha256 === undefined);
		if (deleteError === null || gone) return Ok(undefined);
		switch (deleteError.name) {
			case 'Conflict':
				return EntryError.Changed();
			case 'Unconfirmed':
				return EntryError.Unconfirmed({ cause: deleteError });
			default:
				return EntryError.NotSaved({ cause: deleteError });
		}
	}

	let closing: Promise<void> | undefined;

	return {
		get entries() {
			return entries;
		},
		/** Row files in `entries/` that cannot be shown as words. */
		get unreadable() {
			return unreadable;
		},
		/** Why the words could not be listed at all, until a listing succeeds. */
		get loadError() {
			return loadError;
		},
		refresh,

		/**
		 * Whether an entry with exactly this text is in the list as last read.
		 * A hint for what to show: `add` asks the folder before it answers.
		 */
		has,

		/**
		 * Save a word or a captured phrase, and answer once the folder holds its
		 * file. The text is trimmed and otherwise exact. `present` means a word
		 * with that exact text is already saved and nothing was written, so its
		 * note and stage are untouched. `note` starts empty and `stage` new: both
		 * are the learner's to set.
		 */
		async add(text: string): Promise<Result<'added' | 'present', EntryError>> {
			// The text a file can hold: saving replaces an unpaired surrogate.
			const exact = text.trim().toWellFormed();
			if (exact === '') return EntryError.Empty();
			// The list catches a word whose file has another name, such as one
			// written outside Vocab. It is only what was last read, so each match
			// is read from the folder before it is called present: a word another
			// tab removed is dropped from the list here and saved again below.
			for (const listed of rows.filter((entry) => entry.text === exact)) {
				const { data: current, error: readError } = await table.get(listed.id);
				if (readError !== null)
					return EntryError.NotSaved({ cause: readError });
				const held = current && readEntry(current);
				receive(listed.id, held || undefined);
				if (held?.text === exact) return Ok('present');
			}
			const stem = await hashBytes(new TextEncoder().encode(exact));
			const { data: created, error: createError } = await table.create({
				stem,
				fields: {
					text: exact,
					note: '',
					stage: 'new',
					createdAt: InstantString.now(),
				},
			});
			if (createError === null) {
				// The receipt names the bytes sent; the word is how they read.
				receive(
					stem,
					readEntry({
						...created,
						...inspectRow(vocabFolder.tables.entries, created.text),
					}),
				);
				return Ok('added');
			}
			if (createError.name !== 'Exists')
				return EntryError.NotSaved({ cause: createError });
			// Another add, another tab, or an earlier attempt whose answer was
			// lost made the file. It is this word only if it holds this text.
			const { data: current, error: readError } = await table.get(stem);
			if (readError !== null) return EntryError.NotSaved({ cause: readError });
			const held = current && readEntry(current);
			if (!held || held.text !== exact)
				return EntryError.Taken({ path: createError.path });
			receive(stem, held);
			return Ok('present');
		},

		/**
		 * The editor of one word's note and stage, created on first use, opened
		 * by its card or a stage press, and shared by every view of that word. The note and the stage are the
		 * learner's: only their edits write them.
		 */
		word(id: string): Word {
			let word = words.get(id);
			if (word === undefined) {
				word = createWord({
					table,
					id,
					listed: () => rows.find((entry) => entry.id === id),
					onSettled: () => relist(id),
				});
				words.set(id, word);
				// After closing, a word is shown but starts no work.
				if (closing) void word.close();
			}
			return word;
		},

		/**
		 * Remove the entry's file, if it is still a version the learner was
		 * shown: `chosen`, the entry as the list showed it when they asked,
		 * which the caller fixes then, before any confirmation, so no listing
		 * read meanwhile widens it. The word's input stops at once, its saves
		 * already admitted settle, and only then is the file read and deleted
		 * on that read's condition. A save that failed, or a note no file can
		 * hold, does not stop it: the learner chose to destroy the word with
		 * them. Done, its editor and everything typed there go with it;
		 * refused, they stay as they were. Once the list is closing, nothing
		 * is read or deleted.
		 */
		remove(chosen: Entry): Promise<Result<undefined, EntryError>> {
			if (closing) return Promise.resolve(EntryError.Closed());
			const { id, file: listed } = chosen;
			const word = words.get(id);
			const destroy = (shown: string | undefined) =>
				queued(id, () => deleteChosen(id, listed, shown));
			const removing = word ? word.remove(destroy) : destroy(undefined);
			return (async () => {
				let removed: Result<undefined, EntryError>;
				try {
					const answer = await removing;
					// Another operation holds the word; it is left to finish.
					if (answer === 'busy') return EntryError.Busy();
					removed = answer;
				} catch (cause) {
					// The folder threw instead of answering: the word may be gone.
					// The learner is told, and the word stays as it is shown.
					return EntryError.Unconfirmed({ cause });
				}
				const { error: removeError } = removed;
				if (removeError !== null) {
					// The folder holds something other than what is shown: show that,
					// in the word too unless its save is running or failed.
					if (removeError.name === 'Changed') {
						await refresh();
						if (word?.save?.status === 'idle') await word.reload();
					}
					return removed;
				}
				if (words.get(id) === word) words.delete(id);
				receive(id, undefined);
				return removed;
			})();
		},

		/** How many words have a save running or failed, or a delete in flight or unanswered. */
		get unsettled() {
			let count = 0;
			for (const word of words.values()) if (word.unsettled) count++;
			return count;
		},

		/**
		 * The learner's choice for a word whose file is gone or whose delete
		 * went unanswered: let the word go here. Its editor and any input it
		 * holds go, nothing is written, and the list shows what the folder
		 * holds.
		 */
		async letGo(id: string): Promise<void> {
			const word = words.get(id);
			words.delete(id);
			await word?.close();
			receive(id, undefined);
			await refresh();
		},

		/**
		 * Stop every word before the page releases its folder: no view takes
		 * typing or starts new work, deletes and saves already admitted
		 * settle, and every editor is let go.
		 */
		close(): Promise<void> {
			closing ??= Promise.allSettled([
				...[...words.values()].map((word) => word.close()),
				...queues.values(),
			]).then(() => undefined);
			return closing;
		},
	};
}

export type EntriesState = ReturnType<typeof createEntriesState>;

/** Narrow a failed change to what the learner is told. */
export function entryErrorMessage(error: EntryError): string {
	return error.name === 'Changed'
		? 'This word changed in another tab, so it was not deleted. It has been read again.'
		: error.message;
}
