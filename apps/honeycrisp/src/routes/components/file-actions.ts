/**
 * Actions the file browser, the note editor, and the file view share: copy a
 * path, and delete with a confirmation that names what will be removed.
 */

import { basename } from '@epicenter/folder/file-browser';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { Deletion, Notes } from '$lib/notes.svelte.js';

export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

function describe(deletion: Deletion) {
	switch (deletion.kind) {
		case 'file':
			return {
				title:
					deletion.title !== undefined
						? `Delete “${deletion.title}” permanently?`
						: `Delete ${basename(deletion.file.path)}?`,
				description: `This deletes ${deletion.file.path} from the folder. Committed versions stay in Git history.`,
			};
		case 'folder':
			return {
				title: `Delete the folder ${basename(deletion.path)}?`,
				description: `${deletion.path} is empty. Deleting it removes only the folder.`,
			};
	}
}

/**
 * Ask before deleting `path`. What the dialog names is captured first, and
 * the deletion applies only to that captured version.
 */
export async function confirmDelete(notes: Notes, path: string) {
	const { data: deletion, error: captureError } = await notes.deletionFor(path);
	if (captureError !== null) {
		toast.error(`Could not delete ${basename(path)}`, {
			description: captureError,
		});
		return;
	}
	confirmationDialog.open({
		...describe(deletion),
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const problem = await notes.remove(deletion);
			if (problem)
				toast.error(`Could not delete ${basename(path)}`, {
					description: problem,
				});
		},
	});
}
