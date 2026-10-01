/**
 * Actions the screens share: copy a path or some text, and delete with a
 * confirmation that names what will be removed.
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { describeDeletion } from '$lib/deletion-copy.js';
import { basename } from '$lib/files.js';
import type { Library } from '$lib/library.svelte.js';

export { recordingTitle } from '$lib/deletion-copy.js';

export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

/** Copy text the person asked for. `what` names it: "the transcript". */
export async function copyText(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`Copied ${what}`);
	} catch {
		toast.error(`Could not copy ${what}`);
	}
}

/** A saved time for display, or the raw value when it is not a time. */
export function formatTime(value: unknown, style: 'short' | 'full' = 'full') {
	if (typeof value !== 'string') return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return style === 'short'
		? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
		: date.toLocaleString();
}

/**
 * Ask before deleting `path`. What the dialog names is captured first, and
 * the deletion applies only to that captured version.
 */
export async function confirmDelete(library: Library, path: string) {
	const captured = await library.deletionFor(path);
	if (captured.error !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: captured.error,
		});
		return;
	}
	const deletion = captured.data;
	confirmationDialog.open({
		...describeDeletion(deletion, library.recordingNaming),
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await library.remove(deletion);
			if (problem)
				toast.error(`Could not delete ${basename(path)}`, {
					description: problem,
				});
		},
	});
}
