/**
 * Actions every view of a word shares: open it, and delete it with a
 * confirmation that names it.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Entry } from '$lib/data.js';
import type { EntriesState } from '$lib/entries.svelte.js';

/**
 * Open the word at `id`, asking first when the open word holds a draft it
 * could not save: discarding it lets the open proceed, cancelling keeps the
 * open word.
 */
export async function openWord(entries: EntriesState, id: string) {
	const opening = await entries.open(id);
	if (opening.kind !== 'unsaved') return;
	confirmationDialog.open({
		title: 'Discard unsaved changes?',
		description:
			'The open word has changes that could not be saved. Discard them to open another word, or cancel to keep working on them.',
		confirm: { text: 'Discard', variant: 'destructive' },
		async onConfirm() {
			// The draft the answer named, whatever is open by now.
			await entries.open(id, { discard: opening.session });
		},
	});
}

/** Ask before deleting `entry`, the word as the list showed it when Delete was pressed. */
export function confirmDelete(entries: EntriesState, entry: Entry) {
	confirmationDialog.open({
		title: `Delete “${entry.text}”?`,
		description:
			'Its note and stage are deleted with it. A change that could not be saved is discarded.',
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await entries.remove(entry);
			if (problem)
				toast.error(`Could not delete “${entry.text}”`, {
					description: problem,
				});
		},
	});
}
