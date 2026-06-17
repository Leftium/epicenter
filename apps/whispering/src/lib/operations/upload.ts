import {
	ACCEPT_AUDIO,
	ACCEPT_VIDEO,
	displaySize,
	MEGABYTE,
} from '@epicenter/ui/file-drop-zone';
import { nanoid } from 'nanoid/non-secure';
import { defineErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { analytics } from '$lib/operations/analytics';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { report } from '$lib/report';
import { settings } from '$lib/state/settings.svelte';

/**
 * The single source of truth for what Whispering accepts as an upload.
 *
 * Every entry point — the homepage drop zone, the config-navbar picker, desktop
 * drag-and-drop — reads these, and {@link uploadRecordings} enforces them, so
 * the limits the UI advertises can never drift from the limits actually applied.
 */
export const UPLOAD_ACCEPT = `${ACCEPT_AUDIO}, ${ACCEPT_VIDEO}`;
export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_FILE_SIZE = 25 * MEGABYTE;

const { NoImportableFiles } = defineErrors({
	NoImportableFiles: () => ({
		message: 'No valid audio or video files found',
	}),
});

type UploadSummary = {
	processedCount: number;
	skippedCount: number;
};

type RejectedFile = { file: File; reason: string };

/**
 * Apply the upload policy to a batch of files. Pure: it decides what is allowed,
 * it does not touch the user or kick off processing — callers report and process.
 */
function partitionByPolicy(files: File[]): {
	valid: File[];
	rejected: RejectedFile[];
} {
	const valid: File[] = [];
	const rejected: RejectedFile[] = [];
	for (const file of files) {
		const isAudioOrVideo =
			file.type.startsWith('audio/') || file.type.startsWith('video/');
		if (!isAudioOrVideo) {
			rejected.push({ file, reason: 'Not an audio or video file' });
			continue;
		}
		if (file.size > MAX_UPLOAD_FILE_SIZE) {
			rejected.push({
				file,
				reason: `Larger than the ${displaySize(MAX_UPLOAD_FILE_SIZE)} limit`,
			});
			continue;
		}
		if (valid.length >= MAX_UPLOAD_FILES) {
			rejected.push({
				file,
				reason: `Over the ${MAX_UPLOAD_FILES}-file limit`,
			});
			continue;
		}
		valid.push(file);
	}
	return { valid, rejected };
}

export async function uploadRecordings({
	files,
}: {
	files: File[];
}): Promise<
	Result<UploadSummary, ReturnType<typeof NoImportableFiles>['error']>
> {
	settings.set('recording.mode', 'upload');

	// Enforce the whole policy in one place so every collector — the homepage
	// drop zone, the config-navbar picker, desktop drag-and-drop — applies
	// identical limits and surfaces rejections the same way.
	const { valid, rejected } = partitionByPolicy(files);

	if (rejected.length > 0) {
		report.info({
			title: `${rejected.length} file${rejected.length === 1 ? '' : 's'} skipped`,
			description: rejected
				.map(({ file, reason }) => `${file.name} — ${reason}`)
				.join('\n'),
		});
	}

	if (valid.length === 0) {
		return NoImportableFiles();
	}

	await Promise.all(
		valid.map(async (file) => {
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
				deliverySource: 'upload',
			});
		}),
	);

	return Ok({
		processedCount: valid.length,
		skippedCount: rejected.length,
	});
}
