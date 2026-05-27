import { nanoid } from 'nanoid/non-secure';
import { defineErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { analytics } from '$lib/operations/analytics';
import { notify } from '$lib/operations/notify';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { settings } from '$lib/state/settings.svelte';

const { NoImportableFiles } = defineErrors({
	NoImportableFiles: () => ({
		message: 'No valid audio or video files found',
	}),
});

type UploadSummary = {
	processedCount: number;
	skippedCount: number;
};

export async function uploadRecordings({
	files,
}: {
	files: File[];
}): Promise<
	Result<UploadSummary, ReturnType<typeof NoImportableFiles>['error']>
> {
	settings.set('recording.mode', 'upload');

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
		notify.warning({
			title: '⚠️ Some files were skipped',
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

			const toastId = nanoid();
			await processRecordingPipeline({
				source: {
					kind: 'blob',
					blob: audioBlob,
					recordingId: nanoid(),
					durationMs: 0,
				},
				durationMs: null,
				toastId,
				completionTitle: '📁 File uploaded successfully!',
				completionDescription: file.name,
			});
		}),
	);

	return Ok({
		processedCount: validFiles.length,
		skippedCount: invalidFiles.length,
	});
}
