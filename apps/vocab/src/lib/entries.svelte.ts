/**
 * Reactive entries state: the learner's saved expressions.
 *
 * Read straight out of the reactive Personal store (`fromData`), so a local
 * write and bytes that arrived from another device both show up without a
 * refresh, a subscription, or anything to dispose here.
 *
 * Bound to the signed-in account's Personal document. The route creates it
 * only after capturing that account, and there is one entry pool per account.
 */

import { InstantString } from '@epicenter/app/field';
import type { PersistenceCapability } from '@epicenter/app/store';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { Entry, VocabData } from '$lib/data';

export const EntryError = defineErrors({
	Empty: () => ({ message: 'There is no text to save.' }),
	/** The entry is in the live document, and a restart would lose it. */
	NotSaved: () => ({
		message: "This device's storage did not save the entry.",
	}),
	/** Storage could not be asked at all, as when its store has closed. */
	StorageThrew: ({ cause }: { cause: unknown }) => ({
		message: `This device's storage could not be asked to save the entry: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;

export function createEntriesState({
	data,
}: {
	data: VocabData & { persistence: PersistenceCapability };
}) {
	/** Every saved entry, newest first. */
	const entries = $derived(
		data.tables.entries.rows.toSorted((a, b) =>
			b.createdAt.localeCompare(a.createdAt),
		),
	);

	const has = (text: string) =>
		data.tables.entries.rows.some((entry) => entry.text === text);

	/** `note` starts empty and `stage` new: both are the learner's to set. */
	function create(text: string) {
		data.tables.entries.create({
			text,
			note: '',
			stage: 'new',
			createdAt: InstantString.now(),
		});
	}

	/** Apply a change, or throw so the caller's toast can present it. */
	function update(id: string, changes: Partial<Entry>): void {
		const { error } = data.tables.entries.update(id, changes);
		if (error !== null) throw error;
	}

	return {
		get entries() {
			return entries;
		},

		/** Whether an entry with exactly this text exists. */
		has,

		/**
		 * Whether this device's storage holds everything the entry table has
		 * accepted. While it does not, an entry on screen may be lost on restart.
		 */
		get isStored() {
			return data.persistence.get() === 'saved';
		},

		/**
		 * Save an entry. Saving is explicit: selection capture or the panel
		 * quick-add, never an implicit side effect of reading. Trims and dedupes
		 * by exact text: a repeat save of an already-saved entry is a no-op, not a
		 * duplicate row. `note` starts empty because it is human-owned; no code
		 * path prefills it.
		 */
		save(text: string): boolean {
			const trimmed = text.trim();
			if (!trimmed || has(trimmed)) return false;
			create(trimmed);
			return true;
		},

		/**
		 * Save a phrase and answer once this device's storage has taken it.
		 *
		 * A table write only accepts a row into the live document, so `added` is
		 * reported after the store's flush settles as `saved`, never on the
		 * write alone. `present` means the exact text was already stored and
		 * nothing was written.
		 *
		 * Calling again after a failure is the retry: the accepted row is found
		 * by its exact text and only storage is asked again, so a phrase never
		 * gets a second row.
		 */
		async savePhrase(
			text: string,
		): Promise<Result<'added' | 'present', EntryError>> {
			const trimmed = text.trim();
			if (trimmed === '') return EntryError.Empty();
			// Every store call is inside the boundary: a closed store throws from
			// its reads and its write as well as from its flush. The work up to
			// the first flush still runs before this function first yields, so
			// the row is admitted synchronously.
			const { data: outcome, error } = await tryAsync({
				try: async () => {
					const present = has(trimmed);
					if (present && data.persistence.get() === 'saved') {
						return 'present' as const;
					}
					if (!present) create(trimmed);
					// `flush` resolves after a failed attempt as well as a successful
					// one, and newer accepted work can start another, so the settled
					// status is the answer.
					do await data.persistence.flush();
					while (data.persistence.get() === 'pending');
					return data.persistence.get() === 'saved'
						? ('added' as const)
						: ('unsaved' as const);
				},
				catch: (cause) => EntryError.StorageThrew({ cause }),
			});
			if (error !== null) return Err(error);
			return outcome === 'unsaved' ? EntryError.NotSaved() : Ok(outcome);
		},

		/** Change an entry's acquisition stage. */
		setStage(id: string, stage: Entry['stage']) {
			update(id, { stage });
		},

		/** Edit an entry's note. Note is human-owned: only ever written from user edits. */
		setNote(id: string, note: string) {
			update(id, { note });
		},

		/** Remove an entry from the pool. Idempotent over an already-gone row. */
		remove(id: string) {
			data.tables.entries.delete(id);
		},
	};
}
