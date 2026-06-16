import { nanoid } from 'nanoid/non-secure';
import { defineErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { analytics } from '$lib/operations/analytics';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { report } from '$lib/report';

const { NoImportableFiles } = defineErrors({
	NoImportableFiles: () => ({
		message: 'No valid audio or video files found',
	}),
});

type ImportSummary = {
	processedCount: number;
	skippedCount: number;
};

/**
 * Imports audio/video files and runs each through the transcription pipeline.
 * This is its own surface, separate from the microphone recording triggers:
 * importing a file never touches `recording.trigger`. Works on web (the file
 * picker) and desktop (the picker plus drag-and-drop).
 */
export async function importFiles({
	files,
}: {
	files: File[];
}): Promise<
	Result<ImportSummary, ReturnType<typeof NoImportableFiles>['error']>
> {
	const { valid: validFiles, invalid: invalidFiles } = files.reduce<{
		valid: File[];
		invalid: File[];
	}>(
		(acc, file) => {
			const isValid =
				file.type.startsWith('audio/') || file.type.startsWith('video/');
			acc[isValid ? 'valid' : 'invalid'].push(file);
			return acc;
		},
		{ valid: [], invalid: [] },
	);

	if (validFiles.length === 0) {
		return NoImportableFiles();
	}

	if (invalidFiles.length > 0) {
		report.info({
			title: 'Some files were skipped',
			description: `${invalidFiles.length} file(s) were not audio or video files`,
		});
	}

	await Promise.all(
		validFiles.map(async (file) => {
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

	return Ok({
		processedCount: validFiles.length,
		skippedCount: invalidFiles.length,
	});
}
