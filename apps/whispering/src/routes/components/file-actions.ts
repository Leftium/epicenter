/**
 * Actions the screens share: copy a path or some text, and delete with a
 * confirmation that names what will be removed.
 */
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import type { RecordingEntry } from '$lib/editor.svelte.js';
import { basename } from '$lib/files.js';
import type { Deletion, Library } from '$lib/library.svelte.js';

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

/** A recording's title, or its ID when the title is empty or unreadable. */
export function recordingTitle(entry: RecordingEntry): string {
	const title = entry.fields.title;
	if (typeof title === 'string' && title.trim() !== '') return title;
	return entry.stem ?? entry.path;
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

const count = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

function describe(deletion: Deletion) {
	switch (deletion.kind) {
		case 'recording': {
			const { entry, results, outputs } = deletion;
			const removed = [
				entry.path,
				...(entry.attachment ? [`its audio ${entry.attachment}`] : []),
				...(results.length > 0
					? [
							count(
								results.length,
								'transcription result',
								'transcription results',
							),
						]
					: []),
				...(outputs.length > 0
					? [
							count(
								outputs.length,
								'transformation result',
								'transformation results',
							),
						]
					: []),
			];
			return {
				title: `Delete “${recordingTitle(entry)}”?`,
				description: `This deletes ${removed.join(', ')} from the folder. Committed versions stay in Git history.`,
			};
		}
		case 'transformation': {
			const { entry, results } = deletion;
			const title =
				typeof entry.fields.title === 'string' &&
				entry.fields.title.trim() !== ''
					? entry.fields.title
					: basename(entry.path);
			return {
				title: `Delete the transformation “${title}”?`,
				description: `This deletes ${entry.path} from the folder. ${
					results > 0
						? `Its ${count(results, 'saved result stays', 'saved results stay')} in transformation_runs, each with the prompt it used.`
						: 'It has no saved results.'
				} Committed versions stay in Git history.`,
			};
		}
		case 'file':
			return {
				title: `Delete ${basename(deletion.path)}?`,
				description: `This deletes ${deletion.path} from the folder. Committed versions stay in Git history.`,
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
		...describe(deletion),
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
