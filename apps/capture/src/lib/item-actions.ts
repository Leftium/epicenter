/**
 * Moving between captures and deleting one, with the confirmation each may
 * need. Leaving a capture whose save failed or conflicted, or that holds a
 * thought typed and not added, asks once whether to discard it; the discard
 * is bound to the session the dialog describes.
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Captures, Mode } from './captures.svelte.js';

function openSession(captures: Captures) {
	const item = captures.opened;
	return item?.kind === 'capture' || item?.kind === 'text'
		? item.session
		: undefined;
}

function askToDiscard(proceed: (discard: unknown) => Promise<unknown>) {
	confirmationDialog.open({
		title: 'Discard unsaved changes?',
		description:
			'This capture has text that is not saved. Discard it to go on, or cancel to keep working on it.',
		confirm: { text: 'Discard', variant: 'destructive' },
		async onConfirm() {
			await proceed(undefined);
		},
	});
}

/** Open `stem` as `mode`, asking first when the open capture holds unsaved text. */
export async function openItem(captures: Captures, stem: string, mode: Mode) {
	const session = openSession(captures);
	if ((await captures.open(stem, mode)) !== 'unsaved') return;
	askToDiscard(() => captures.open(stem, mode, { discard: session }));
}

/** Go back to the timeline, asking first when the open capture holds unsaved text. */
export async function backToTimeline(captures: Captures) {
	const session = openSession(captures);
	if ((await captures.back()) !== 'unsaved') return;
	askToDiscard(() => captures.back({ discard: session }));
}

/** Ask before deleting the open capture; the delete acts on what this window saved last. */
export function confirmDelete(captures: Captures, title: string) {
	const session = openSession(captures);
	if (session === undefined) return;
	confirmationDialog.open({
		title: 'Delete this capture?',
		description: `${title ? `“${title}” ` : ''}and its thoughts are deleted from the folder. Text here that is not saved is discarded too. Committed versions stay in Git history.`,
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await captures.remove(session);
			if (problem) toast.error('The capture was not deleted', { description: problem });
		},
	});
}
