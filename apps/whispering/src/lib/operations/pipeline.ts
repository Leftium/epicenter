import { nanoid } from 'nanoid/non-secure';
import { goto } from '$app/navigation';
import {
	deliverTranscriptionResult,
	deliverTransformationResult,
} from '$lib/operations/delivery';
import { sound } from '$lib/operations/sound';
import { transcribeAudio } from '$lib/operations/transcribe';
import { runTransformation } from '$lib/operations/transform';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { pcmToWavBlob } from '$lib/services/recorder/pcm-to-wav';
import type { RecorderAudio } from '$lib/services/recorder/types';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';

/**
 * Processes a recording through the full pipeline: save -> transcribe -> transform.
 *
 * The transcribe and transform steps each own their own loading toast; the
 * delivery layer resolves them with the success message that already
 * includes "copied to clipboard" / "written to cursor" flags. No outer
 * pipeline-level toast is needed; the delivery messages ARE the completion
 * signal.
 *
 * @param recordingId - Optional recording ID. When provided (e.g., from CPAL recorder),
 * the ID was generated earlier in the pipeline and is passed through for consistency.
 * When omitted (e.g., VAD recording, file uploads), a new ID is generated here.
 * @param source - Whether the audio came from a live recording (default) or a
 * file upload. Drives the success-toast copy ("Recording transcribed" vs
 * "File transcribed"). The transcription/transform/delivery logic is identical.
 */
export async function processRecordingPipeline({
	audio,
	recordingId,
	durationMs,
	source = 'recording',
}: {
	audio: RecorderAudio;
	recordingId?: string;
	durationMs: number | null;
	source?: 'recording' | 'upload';
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

	const transcribeLoading = report.loading({
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
		transcribeLoading.reject({ cause: transcribeError });
		return;
	}

	sound.playSoundIfEnabled('transcriptionComplete');
	const transcribeNotice = await deliverTranscriptionResult({
		text: transcribedText,
		source,
	});
	transcribeLoading.resolve(transcribeNotice);

	const { error: saveAudioError } = await saveAudioPromise;
	if (saveAudioError) {
		report.error({
			title: 'Audio not saved',
			cause: saveAudioError,
		});
	}

	recordings.update(recording.id, {
		transcript: transcribedText,
		transcriptionStatus: 'DONE',
	});

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
			recordingId: recording.id,
		});
	if (transformError) {
		transformLoading.reject({ cause: transformError });
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	const transformNotice = await deliverTransformationResult({
		text: transformedText,
	});
	transformLoading.resolve(transformNotice);
}
