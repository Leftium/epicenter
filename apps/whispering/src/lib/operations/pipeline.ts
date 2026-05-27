import { nanoid } from 'nanoid/non-secure';
import {
	deliverTranscriptionResult,
	deliverTransformationResult,
} from '$lib/operations/delivery';
import { notify } from '$lib/operations/notify';
import { sound } from '$lib/operations/sound';
import { transcribeAudio } from '$lib/operations/transcribe';
import { runTransformation } from '$lib/operations/transform';
import { services } from '$lib/services';
import type { RecorderStopResult } from '$lib/services/recorder/types';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';

/**
 * Argument shape for the pipeline. The recorder produces a
 * `RecorderStopResult`; the VAD path and file-upload path build the
 * equivalent shape with `kind: 'blob'`. The pipeline picks an id from
 * the result (or generates one for legacy blob callers that don't carry
 * one yet) and treats the recording as a Rust-owned artifact from then on.
 */
type PipelineInput = {
	source: RecorderStopResult;
	durationMs: number | null;
	toastId: string;
	completionTitle: string;
	completionDescription: string;
};

/**
 * Processes a recording through the full pipeline: persist artifact ->
 * transcribe by id -> transform.
 *
 * Audio bytes never live in pipeline state. For cpal sources Rust has
 * already written the durable artifact at
 * `<appDataDir>/recordings/{id}.wav` by the time we get here. For blob
 * sources (navigator MediaRecorder, VAD, file upload) we persist the
 * bytes through the recordings blob store, then operate on the id.
 */
export async function processRecordingPipeline({
	source,
	durationMs,
	toastId,
	completionTitle,
	completionDescription,
}: PipelineInput) {
	const now = new Date().toISOString();
	const recordingId =
		source.kind === 'artifact' ? source.artifact.id : source.recordingId;

	const recording = {
		id: recordingId,
		title: '',
		recordedAt: now,
		updatedAt: now,
		transcript: '',
		duration: durationMs,
		transcriptionStatus: 'UNPROCESSED',
	} as const;

	recordings.set(recording);

	// Persist the audio before transcription. For cpal artifacts this is
	// a no-op (Rust already wrote the WAV). For blobs we save through the
	// recordings blob store, which writes to the same on-disk location in
	// Tauri (`recordings/{id}.{ext}`) and to IndexedDB on the web. The
	// next steps look the file up by id, so this save MUST complete first.
	if (source.kind === 'blob') {
		const { error: saveError } = await services.blobs.audio.save(
			recordingId,
			source.blob,
		);
		if (saveError) {
			notify.warning({
				id: toastId,
				title: '⚠️ Audio not saved',
				description:
					'We could not save the recording bytes; transcription will continue but history playback will be unavailable.',
				action: { type: 'more-details', error: saveError },
			});
		}
	}

	const transcribeToastId = nanoid();
	notify.loading({
		id: transcribeToastId,
		title: '📋 Transcribing...',
		description: 'Your recording is being transcribed...',
	});

	const { data: transcribedText, error: transcribeError } =
		await transcribeAudio(recordingId);

	if (transcribeError) {
		recordings.update(recordingId, { transcriptionStatus: 'FAILED' });
		if (transcribeError.name === 'WhisperingError') {
			notify.error({ id: transcribeToastId, ...transcribeError });
			return;
		}
		notify.error({
			id: transcribeToastId,
			title: '❌ Failed to transcribe recording',
			description: 'Your recording could not be transcribed.',
			action: { type: 'more-details', error: transcribeError },
		});
		return;
	}

	sound.playSoundIfEnabled('transcriptionComplete');
	await deliverTranscriptionResult({
		text: transcribedText,
		toastId: transcribeToastId,
	});

	notify.success({
		id: toastId,
		title: completionTitle,
		description: completionDescription,
	});

	recordings.update(recordingId, {
		transcript: transcribedText,
		transcriptionStatus: 'DONE',
	});

	const transformationId = settings.get('transformation.selectedId');
	if (!transformationId) return;

	const transformation = transformations.get(transformationId);
	if (!transformation) {
		settings.set('transformation.selectedId', null);
		notify.warning({
			title: '⚠️ No matching transformation found',
			description:
				'No matching transformation found. Please select a different transformation.',
			action: {
				type: 'link',
				label: 'Select a different transformation',
				href: '/transformations',
			},
		});
		return;
	}

	const transformToastId = nanoid();
	notify.loading({
		id: transformToastId,
		title: '🔄 Running transformation...',
		description:
			'Applying your selected transformation to the transcribed text...',
	});

	const { data: result, error: transformError } = await runTransformation({
		input: transcribedText,
		transformation,
		recordingId,
	});
	if (transformError) {
		notify.error({
			id: transformToastId,
			title: '⚠️ Transformation failed',
			description: transformError.message,
			action: { type: 'more-details', error: transformError },
		});
		return;
	}

	if (result.status === 'failed') {
		notify.error({
			id: transformToastId,
			title: '⚠️ Transformation error',
			description: result.error,
			action: { type: 'more-details', error: result.error },
		});
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	await deliverTransformationResult({
		text: result.output,
		toastId: transformToastId,
	});
}
