/**
 * What a person is told before a deletion: which files go and which stay.
 *
 * Plain text over a captured deletion, with no UI imports, so the wording can
 * be checked against what `library.remove` does to the folder.
 */
import { audioPathIn } from './definition.js';
import type { RecordingEntry } from './editor.svelte.js';
import { basename } from './files.js';
import type { Deletion } from './library.svelte.js';

/** A recording's title, or its ID when the title is empty or did not validate. */
export function recordingTitle(entry: RecordingEntry): string {
	const { title } = entry.fields;
	if (title !== undefined && title.trim() !== '') return title;
	// An empty ID (`recordings/.md`) is a real address but not a readable label.
	return entry.stem === '' ? entry.path : entry.stem;
}

const count = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

export function describeDeletion(
	deletion: Deletion,
	/** The recording that names a file as its audio, when one does. */
	namedBy: (path: string) => RecordingEntry | undefined,
): { title: string; description: string } {
	switch (deletion.kind) {
		case 'recording': {
			const { entry, results, outputs } = deletion;
			const audioPath = audioPathIn(entry.fields);
			const removed = [
				entry.path,
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
				// The row is deleted. Its audio is a separate file that no row owns.
				description: `This deletes ${removed.join(', ')} from the folder. ${
					audioPath
						? `Its audio ${audioPath} is not deleted: it stays in the folder as an ordinary file, and you can delete it from Files. `
						: ''
				}Committed versions stay in Git history.`,
			};
		}
		case 'transformation': {
			const { entry, results } = deletion;
			const named = entry.fields.title;
			const title =
				named !== undefined && named.trim() !== ''
					? named
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
		case 'file': {
			const recording = namedBy(deletion.path);
			return {
				title: `Delete ${basename(deletion.path)}?`,
				description: `This deletes ${deletion.path} from the folder. ${
					recording
						? `The recording “${recordingTitle(recording)}” names it as its audio and is kept, with no audio to play or transcribe. `
						: ''
				}Committed versions stay in Git history.`,
			};
		}
		case 'folder':
			return {
				title: `Delete the folder ${basename(deletion.path)}?`,
				description: `${deletion.path} is empty. Deleting it removes only the folder.`,
			};
	}
}
