import { InstantString } from '@epicenter/field';
import { IanaTimeZone } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { goto } from '$app/navigation';
import {
	deliverTranscriptionResult,
	deliverTransformationResult,
	type TranscriptionSource,
} from '$lib/operations/delivery';
import { sound } from '$lib/operations/sound';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import { runTransformation } from '$lib/operations/transform';
import { report } from '$lib/report';
import { services } from '$lib/services';
import type { RecorderStopResult } from '$lib/services/recorder/types';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';

/**
 * Argument shape for the pipeline. The recorder produces a
 * `RecorderStopResult`; the VAD path and file import path build the
 * equivalent shape with `kind: 'blob'`. `deliverySource` is forwarded
 * straight to delivery, so it shares delivery's `TranscriptionSource` type.
 */
type PipelineInput = {
	source: RecorderStopResult;
	durationMs: number | null;
	deliverySource?: TranscriptionSource;
};

/**
 * Processes a recording through the full pipeline: persist artifact,
 * transcribe by id, then transform.
 *
 * Audio bytes never live in pipeline state. For cpal sources Rust has
 * already written the durable artifact at
 * `<appDataDir>/recordings/{id}.wav` by the time we get here. For blob
 * sources (navigator MediaRecorder, VAD, file import) we persist the
 * bytes through the recordings blob store, then operate on the id.
 *
 * `deliverySource` only shapes the success copy (recording vs file import).
 */
export async function processRecordingPipeline({
	source,
	durationMs,
	deliverySource = 'recording',
}: PipelineInput) {
	const now = InstantString.now();
	const recordingId =
		source.kind === 'artifact' ? source.artifact.id : source.recordingId;

	// A live dictation (not a file import) drives the dictation pill. The
	// recorder is already idle by the time we get here, so the lifecycle hands
	// the pill from `recording` to `transcribing`. File imports have their own
	// surface, so they leave the dictation lifecycle untouched.
	const isDictation = deliverySource === 'recording';
	if (isDictation) dictationLifecycle.markTranscribing();

	recordings.set({
		id: recordingId,
		title: '',
		recordedAt: now,
		recordedAtZone: IanaTimeZone.current(),
		transcript: '',
		duration: durationMs,
		transcription: null,
	});

	if (source.kind === 'blob') {
		const { error: saveError } = await services.blobs.audio.save(
			recordingId,
			source.blob,
		);
		if (saveError) {
			// Transcription reads by id from disk: if the save failed there
			// is nothing to transcribe. Bailing here surfaces the real
			// failure instead of the misleading "no recording artifact
			// found" the transcribe path would emit on the empty directory.
			recordings.update(recordingId, {
				transcription: {
					status: 'failed',
					completedAt: InstantString.now(),
					error: extractErrorMessage(saveError),
				},
			});
			if (isDictation)
				dictationLifecycle.markFailed({
					tier: 'transcription',
					error: saveError,
					recordingId,
				});
			report.error({
				title: 'Failed to save recording',
				description:
					'We could not write the recording bytes; transcription cannot continue.',
				cause: saveError,
			});
			return;
		}
	}

	const transcribeLoading = report.loading({
		title: '📋 Transcribing...',
		description: 'Your recording is being transcribed...',
	});

	const { data: transcribedText, error: transcribeError } =
		await transcribeAndPersist(recordingId);

	if (transcribeError) {
		if (isDictation)
			dictationLifecycle.markFailed({
				tier: 'transcription',
				error: transcribeError,
				recordingId,
			});
		transcribeLoading.reject({ cause: transcribeError });
		return;
	}

	sound.playSoundIfEnabled('transcriptionComplete');
	const transcribeNotice = await deliverTranscriptionResult({
		text: transcribedText,
		source: deliverySource,
	});
	transcribeLoading.resolve(transcribeNotice);
	// The transcript landed: flash the delivered confirmation on the pill. The
	// transformation step below, if any, runs as a background enhancement and is
	// not part of the dictation receipt.
	if (isDictation) dictationLifecycle.markDelivered();

	const transformationId = settings.get('transformation.selectedId');
	if (!transformationId) return;

	const transformation = transformations.get(transformationId);
	if (!transformation) {
		settings.set('transformation.selectedId', null);
		report.info({
			title: 'No matching transformation found',
			description:
				'No matching transformation found. Please select a different transformation.',
			action: {
				label: 'Select a different transformation',
				onClick: () => goto('/transformations'),
			},
		});
		return;
	}

	const transformLoading = report.loading({
		title: '🔄 Running transformation...',
		description:
			'Applying your selected transformation to the transcribed text...',
	});

	const { data: transformedText, error: transformError } =
		await runTransformation({
			input: transcribedText,
			transformation,
			recordingId,
		});
	if (transformError) {
		transformLoading.reject({ cause: transformError });
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	const transformNotice = await deliverTransformationResult({
		text: transformedText,
		recordingId,
	});
	transformLoading.resolve(transformNotice);
}

/**
 * Re-run transcription and delivery for an already-saved recording, driving the
 * dictation pill the whole way. Used by the failed pill's Retry: the audio is
 * still on disk under `recordingId`, so this skips capture and the row/blob
 * setup and just retries the part that failed. Transformation is deliberately
 * left out, matching the per-row retry: a retry re-transcribes, it does not
 * re-derive a transformation.
 */
export async function runTranscriptionForRecording(
	recordingId: string,
): Promise<void> {
	dictationLifecycle.markTranscribing();

	const { data: transcribedText, error } =
		await transcribeAndPersist(recordingId);
	if (error) {
		dictationLifecycle.markFailed({
			tier: 'transcription',
			error,
			recordingId,
		});
		return;
	}

	sound.playSoundIfEnabled('transcriptionComplete');
	await deliverTranscriptionResult({ text: transcribedText });
	dictationLifecycle.markDelivered();
}
