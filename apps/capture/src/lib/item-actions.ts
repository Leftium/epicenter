/**
 * Moving between captures and deleting one, with the confirmation each may
 * need. Leaving a capture whose save failed or conflicted, or that holds a
 * thought typed and not added, asks once whether to discard it; the discard
 * is bound to the session the store answered, not one read before asking.
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Captures, Mode } from './captures.svelte.js';

type Opening = Awaited<ReturnType<Captures['open']>>;
type Session = Extract<Opening, { kind: 'unsaved' }>['session'];

/** When `opening` answered `unsaved`, ask, and on Discard go on letting that session go. */
function askToDiscard(
	opening: Opening,
	proceed: (discard: Session) => Promise<unknown>,
) {
	if (opening.kind !== 'unsaved') return;
	const { session } = opening;
	confirmationDialog.open({
		title: 'Discard unsaved changes?',
		description:
			'This capture has text that is not saved. Discard it to go on, or cancel to keep working on it.',
		confirm: { text: 'Discard', variant: 'destructive' },
		async onConfirm() {
			await proceed(session);
		},
	});
}

/** Open `stem` as `mode`, asking first when the open capture holds unsaved text. */
export async function openItem(captures: Captures, stem: string, mode: Mode) {
	askToDiscard(await captures.open(stem, mode), (discard) =>
		captures.open(stem, mode, { discard }),
	);
}

/** Go back to the timeline, asking first when the open capture holds unsaved text. */
export async function backToTimeline(captures: Captures) {
	askToDiscard(await captures.leave(), (discard) =>
		captures.leave({ discard }),
	);
}

/** Ask before deleting the open capture; the delete acts on what this window saved last. */
export function confirmDelete(captures: Captures, title: string) {
	const item = captures.opened;
	if (item?.kind !== 'capture' && item?.kind !== 'text') return;
	const { session } = item;
	confirmationDialog.open({
		title: 'Delete this capture?',
		description: `${title ? `“${title}” ` : ''}and its thoughts are deleted from the folder. Text here that is not saved is discarded too. Committed versions stay in Git history.`,
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await captures.remove(session);
			if (problem)
				toast.error('The capture was not deleted', { description: problem });
		},
	});
}
