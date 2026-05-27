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
import { pcmToWavBlob } from '$lib/services/recorder/pcm-to-wav';
import type { RecorderAudio } from '$lib/services/recorder/types';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';

/**
 * Processes a recording through the full pipeline: save -> transcribe -> transform.
 *
 * @param recordingId - Optional recording ID. When provided (e.g., from CPAL recorder),
 * the ID was generated earlier in the pipeline and is passed through for consistency.
 * When omitted (e.g., VAD recording, file uploads), a new ID is generated here.
 */
export async function processRecordingPipeline({
	audio,
	recordingId,
	durationMs,
	toastId,
	completionTitle,
	completionDescription,
}: {
	audio: RecorderAudio;
	recordingId?: string;
	durationMs: number | null;
	toastId: string;
	completionTitle: string;
	completionDescription: string;
}) {
	const now = new Date().toISOString();
	const newRecordingId = recordingId ?? nanoid();

	const recording = {
		id: newRecordingId,
		title: '',
		recordedAt: now,
		updatedAt: now,
		transcript: '',
		duration: durationMs,
		transcriptionStatus: 'UNPROCESSED',
	} as const;

	const transcribeToastId = nanoid();
	notify.loading({
		id: transcribeToastId,
		title: '📋 Transcribing...',
		description: 'Your recording is being transcribed...',
	});

	recordings.set(recording);
	// History save consumes a Blob: PCM gets WAV-synthesized once, Blob is
	// passed through. Run the save in parallel with transcription.
	const saveAudioPromise = (async () => {
		const blob = audio instanceof Blob ? audio : pcmToWavBlob(audio);
		return await services.blobs.audio.save(recording.id, blob);
	})();
	const transcribePromise = transcribeAudio(audio);

	const { data: transcribedText, error: transcribeError } =
		await transcribePromise;

	if (transcribeError) {
		recordings.update(recording.id, { transcriptionStatus: 'FAILED' });
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

	const { error: saveAudioError } = await saveAudioPromise;
	if (saveAudioError) {
		notify.warning({
			id: toastId,
			title: '⚠️ Audio not saved',
			description: 'Transcription delivered but audio blob was not saved.',
			action: { type: 'more-details', error: saveAudioError },
		});
	}

	notify.success({
		id: toastId,
		title: completionTitle,
		description: completionDescription,
	});

	recordings.update(recording.id, {
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
		recordingId: recording.id,
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
