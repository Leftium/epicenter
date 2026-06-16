import { nanoid } from 'nanoid/non-secure';
import { analytics } from '$lib/operations/analytics';
import { processRecordingPipeline } from '$lib/operations/pipeline';

/**
 * Imports audio/video files and runs each through the transcription pipeline.
 * This is its own surface, separate from the microphone recording triggers:
 * importing a file never touches `recording.trigger`. Works on web (the file
 * picker) and desktop (the picker plus drag-and-drop). Callers own validation
 * (extension or `accept` MIME filtering) before handing files here.
 */
export async function importFiles({ files }: { files: File[] }): Promise<void> {
	await Promise.all(
		files.map(async (file) => {
			const arrayBuffer = await file.arrayBuffer();
			const audioBlob = new Blob([arrayBuffer], { type: file.type });

			analytics.logEvent({
				type: 'file_uploaded',
				blob_size: audioBlob.size,
			});

			await processRecordingPipeline({
				source: {
					kind: 'blob',
					blob: audioBlob,
					recordingId: nanoid(),
					durationMs: null,
				},
				durationMs: null,
				deliverySource: 'import',
			});
		}),
	);
}
