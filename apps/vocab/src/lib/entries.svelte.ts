/**
 * The learner's saved words, read from and saved to the folder's `entries`
 * table.
 *
 * What is listed is what the folder has answered for: a word appears once
 * its file's receipt arrives, and an edit is listed once its receipt does.
 * Notes and stages are edited through one retained row editor per word (see
 * `word.svelte.ts`), shared by every view of that word; its saves write the
 * whole word. A removal is made against the capture of the file as it was
 * last read here, so a word that changed elsewhere is refused and read again.
 *
 * A new word's file is named by the SHA-256 of its exact text, and creation
 * is exclusive. Two adds of one text, in one tab or two, or a retry after an
 * answer that never arrived, therefore reach the same file: one creates it
 * and the others find it, with its note and stage as they are.
 */

import { InstantString } from '@epicenter/app/field';
import { hashBytes } from '@epicenter/folder';
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
} from './data.js';
import { createReread } from './reread.js';
import { createWordDraft, type WordDraft } from './word.svelte.js';

export const EntryError = defineErrors({
	Empty: () => ({ message: 'There is no text to save.' }),
	/** The word is no longer in the list this edit was made from. */
	Gone: () => ({ message: 'This word is no longer in your words.' }),
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
	const words = new Map<string, WordDraft>();

	const refresh = createReread(async () => {
		const before = receipts;
		const listed = await table.list();
		if (before !== receipts) return false;
		if (listed.error !== null) {
			loadError = listed.error.message;
			return true;
		}
		const read = readRows(listed.data, readEntry);
		const ids = new Set(read.rows.map((entry) => entry.id));
		// A word removed elsewhere stays listed while a note typed here for it
		// is unsaved; the next save writes it back. Otherwise its editor goes.
		const kept = rows.filter(
			(entry) => !ids.has(entry.id) && words.get(entry.id)?.unsettled,
		);
		for (const [id, word] of words)
			if (!ids.has(id) && !word.unsettled) {
				words.delete(id);
				void word.dispose();
			}
		rows = [...read.rows, ...kept];
		unreadable = read.unreadable;
		loadError = null;
		// A change hint may never have reached an editor; each reads its word again.
		if (!closing)
			await Promise.all([...words.values()].map((word) => word.refresh()));
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

	/** Delete the word's file as it is listed when this runs. */
	async function deleteListed(
		id: string,
	): Promise<Result<undefined, EntryError>> {
		const entry = rows.find((row) => row.id === id);
		if (!entry) return EntryError.Gone();
		const removed = await table.delete(entry.file);
		// Already removed elsewhere: the word is gone, which is what was asked.
		const gone =
			removed.error?.name === 'NotFound' ||
			(removed.error?.name === 'Conflict' &&
				removed.error.actualSha256 === undefined);
		if (removed.error === null || gone) return Ok(undefined);
		switch (removed.error.name) {
			case 'Conflict':
				return EntryError.Changed();
			case 'Unconfirmed':
				return EntryError.Unconfirmed({ cause: removed.error });
			default:
				return EntryError.NotSaved({ cause: removed.error });
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
				const current = await table.get(listed.id);
				if (current.error !== null)
					return EntryError.NotSaved({ cause: current.error });
				const held = current.data && readEntry(current.data);
				receive(listed.id, held || undefined);
				if (held?.text === exact) return Ok('present');
			}
			const stem = await hashBytes(new TextEncoder().encode(exact));
			const created = await table.create({
				stem,
				fields: {
					text: exact,
					note: '',
					stage: 'new',
					createdAt: InstantString.now(),
				},
			});
			if (created.error === null) {
				receive(stem, readEntry(created.data));
				return Ok('added');
			}
			if (created.error.name !== 'Exists')
				return EntryError.NotSaved({ cause: created.error });
			// Another add, another tab, or an earlier attempt whose answer was
			// lost made the file. It is this word only if it holds this text.
			const current = await table.get(stem);
			if (current.error !== null)
				return EntryError.NotSaved({ cause: current.error });
			const held = current.data && readEntry(current.data);
			if (!held || held.text !== exact)
				return EntryError.Taken({ path: created.error.path });
			receive(stem, held);
			return Ok('present');
		},

		/**
		 * The editor of one word's note and stage, opened on first use and
		 * shared by every view of that word. The note and the stage are the
		 * learner's: only their edits write them.
		 */
		word(id: string): WordDraft {
			let word = words.get(id);
			if (word === undefined) {
				word = createWordDraft({
					table,
					id,
					onSaved: (entry) => receive(id, entry),
				});
				words.set(id, word);
				// After closing, a word is shown but starts no work.
				if (closing) void word.dispose();
			}
			return word;
		},

		/**
		 * Remove the entry's file, if it is still the one shown here. The word's
		 * own editor deletes it, after any of its work already admitted, and no
		 * view of the word starts a save meanwhile. Done, its editor and any note
		 * typed there go with it; refused, they stay.
		 */
		remove(id: string): Promise<Result<undefined, EntryError>> {
			return queued(id, async () => {
				const word = words.get(id);
				let removed: Result<undefined, EntryError>;
				try {
					removed = word
						? await word.remove(() => deleteListed(id))
						: await deleteListed(id);
				} catch (cause) {
					// The folder threw instead of answering: the word may be gone.
					// The learner is told, and the word stays as it is shown.
					return EntryError.Unconfirmed({ cause });
				}
				if (removed.error !== null) {
					// The folder holds something other than what is shown: show that.
					if (removed.error.name === 'Changed') await refresh();
					return removed;
				}
				if (words.get(id) === word) words.delete(id);
				receive(id, undefined);
				return removed;
			});
		},

		/** How many words hold typed text that is not saved, or work in flight. */
		get unsettled() {
			let count = 0;
			for (const word of words.values()) if (word.unsettled) count++;
			return count;
		},

		/**
		 * The learner's choice after a delete whose answer was lost: let the
		 * word go here. Its editor and anything typed in it go, nothing is
		 * written, and the list shows what the folder holds.
		 */
		async letGo(id: string): Promise<void> {
			const word = words.get(id);
			words.delete(id);
			await word?.dispose();
			receive(id, undefined);
			await refresh();
		},

		/**
		 * Stop every word before the page releases its folder: no view starts
		 * new work, work already admitted settles, and every editor is let go.
		 * Nothing typed is saved by closing.
		 */
		close(): Promise<void> {
			closing ??= Promise.allSettled(
				[...words.values()].map((word) => word.dispose()),
			).then(() => undefined);
			return closing;
		},
	};
}

export type EntriesState = ReturnType<typeof createEntriesState>;

/** Narrow a failed change to what the learner is told. */
export function entryErrorMessage(error: EntryError): string {
	return error.name === 'Changed'
		? 'This word changed in another tab, so your change was not saved. It has been read again.'
		: error.message;
}
