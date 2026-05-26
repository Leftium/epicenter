import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import { defineMutation, queryClient } from '$lib/query/client';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { services } from '$lib/services';
import { desktopServices } from '$lib/services/desktop';
import { TRANSCRIPTION_SERVICES } from '$lib/services/transcription/registry';
import { deviceConfig } from '$lib/state/device-config.svelte';
import type { Recording } from '$lib/state/recordings.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { analytics } from './analytics';
import { notify } from './notify';
import { deepgramErrorToWhisperingErr } from './transcription-errors/deepgram';
import { elevenlabsErrorToWhisperingErr } from './transcription-errors/elevenlabs';
import { groqErrorToWhisperingErr } from './transcription-errors/groq';
import { mistralErrorToWhisperingErr } from './transcription-errors/mistral';
import { openaiErrorToWhisperingErr } from './transcription-errors/openai';

const transcriptionKeys = {
	isTranscribing: ['transcription', 'isTranscribing'] as const,
} as const;

/**
 * Services that upload audio bytes to a remote endpoint (cloud APIs +
 * self-hosted). The local engines (whispercpp, parakeet, moonshine) decode
 * the blob in-process via the Rust decoder, so compressing their input
 * would just round-trip through libopus for no win.
 */
function isUploadTranscriptionService(serviceId: string): boolean {
	const entry = TRANSCRIPTION_SERVICES.find((s) => s.id === serviceId);
	return entry?.location === 'cloud' || entry?.location === 'self-hosted';
}

/**
 * Heuristic that catches the cpal recorder output (which is the only WAV
 * source we expect to compress). The new Opus encoder rejects non-WAV
 * input anyway; this just avoids paying the IPC round-trip when we already
 * know the blob is something else.
 */
function blobLooksLikeWav(blob: Blob): boolean {
	const type = blob.type.toLowerCase();
	return (
		type === 'audio/wav' || type === 'audio/wave' || type === 'audio/x-wav'
	);
}

function getOutputLanguage(): SupportedLanguage {
	const language = settings.get('transcription.language');
	for (const supportedLanguage of SUPPORTED_LANGUAGES) {
		if (supportedLanguage === language) {
			return supportedLanguage;
		}
	}
	return 'auto';
}

export const transcription = {
	isCurrentlyTranscribing() {
		return (
			queryClient.isMutating({
				mutationKey: transcriptionKeys.isTranscribing,
			}) > 0
		);
	},
	transcribeRecording: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (
			recording: Recording,
		): Promise<Result<string, WhisperingError>> => {
			// Fetch audio blob by ID
			const { data: audioBlob, error: getAudioBlobError } =
				await services.blobs.audio.getBlob(recording.id);

			if (getAudioBlobError) {
				return WhisperingErr({
					title: '⚠️ Failed to fetch audio',
					description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
				});
			}

			recordings.update(recording.id, { transcriptionStatus: 'TRANSCRIBING' });
			const { data: transcribedText, error: transcribeError } =
				await transcribeBlob(audioBlob);
			if (transcribeError) {
				recordings.update(recording.id, { transcriptionStatus: 'FAILED' });
				return Err(transcribeError);
			}

			recordings.update(recording.id, {
				transcript: transcribedText,
				transcriptionStatus: 'DONE',
			});
			return Ok(transcribedText);
		},
	}),

	transcribeRecordings: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map(async (recording) => {
					// Fetch audio blob by ID
					const { data: audioBlob, error: getAudioBlobError } =
						await services.blobs.audio.getBlob(recording.id);

					if (getAudioBlobError) {
						return WhisperingErr({
							title: '⚠️ Failed to fetch audio',
							description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
						});
					}

					return await transcribeBlob(audioBlob);
				}),
			);
			const partitionedResults = partitionResults(results);
			return Ok(partitionedResults);
		},
	}),
};

/**
 * Transcribe an audio blob directly without any database operations.
 * Use this when you need parallel execution and will handle DB updates separately.
 */
export async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	const selectedService = settings.get('transcription.service');

	// Log transcription request
	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	// Opus-compress WAV uploads on the cloud path. cpal records ~960 KB/min
	// uncompressed; libopus voice mode brings that to ~50 KB/min with no
	// perceptible quality loss for transcription. Skipped for local engines
	// (the Rust decoder consumes the raw WAV directly) and for already-
	// compressed inputs (navigator MediaRecorder, file uploads).
	let audioToTranscribe = blob;
	if (
		window.__TAURI_INTERNALS__ &&
		isUploadTranscriptionService(selectedService) &&
		blobLooksLikeWav(blob)
	) {
		const { data: oggBlob, error: encodeError } =
			await desktopServices.audioEncoder.encodeWavToOpusOgg(blob);

		if (encodeError) {
			notify.warning({
				title: 'Audio compression skipped',
				description: `${encodeError.message}. Uploading original audio instead.`,
			});
			analytics.logEvent({
				type: 'compression_failed',
				provider: selectedService,
				error_message: encodeError.message,
			});
		} else {
			audioToTranscribe = oggBlob;
			analytics.logEvent({
				type: 'compression_completed',
				provider: selectedService,
				original_size: blob.size,
				compressed_size: oggBlob.size,
				compression_ratio: Math.round((1 - oggBlob.size / blob.size) * 100),
			});
		}
	}

	const transcriptionResult: Result<string, WhisperingError> =
		await (async () => {
			const outputLanguage = getOutputLanguage();
			const prompt = settings.get('transcription.prompt');
			const temperature = String(settings.get('transcription.temperature'));

			switch (selectedService) {
				case 'OpenAI': {
					const { data, error } =
						await services.transcriptions.openai.transcribe(audioToTranscribe, {
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.openai'),
							modelName: settings.get('transcription.openai.model'),
							baseURL: deviceConfig.get('apiEndpoints.openai') || undefined,
						});
					if (error) return openaiErrorToWhisperingErr(error);
					return Ok(data);
				}
				case 'Groq': {
					const { data, error } = await services.transcriptions.groq.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.groq'),
							modelName: settings.get('transcription.groq.model'),
							baseURL: deviceConfig.get('apiEndpoints.groq') || undefined,
						},
					);
					if (error) return groqErrorToWhisperingErr(error);
					return Ok(data);
				}
				case 'speaches':
					return await services.transcriptions.speaches.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							modelId: deviceConfig.get('transcription.speaches.modelId'),
							baseUrl: deviceConfig.get('transcription.speaches.baseUrl'),
						},
					);
				case 'ElevenLabs': {
					const { data, error } =
						await services.transcriptions.elevenlabs.transcribe(
							audioToTranscribe,
							{
								outputLanguage,
								prompt,
								temperature,
								apiKey: deviceConfig.get('apiKeys.elevenlabs'),
								modelName: settings.get('transcription.elevenlabs.model'),
							},
						);
					if (error) return elevenlabsErrorToWhisperingErr(error);
					return Ok(data);
				}
				case 'Deepgram': {
					const { data, error } =
						await services.transcriptions.deepgram.transcribe(
							audioToTranscribe,
							{
								outputLanguage,
								prompt,
								temperature,
								apiKey: deviceConfig.get('apiKeys.deepgram'),
								modelName: settings.get('transcription.deepgram.model'),
							},
						);
					if (error) return deepgramErrorToWhisperingErr(error);
					return Ok(data);
				}
				case 'Mistral': {
					const { data, error } =
						await services.transcriptions.mistral.transcribe(
							audioToTranscribe,
							{
								outputLanguage,
								prompt,
								temperature,
								apiKey: deviceConfig.get('apiKeys.mistral'),
								modelName: settings.get('transcription.mistral.model'),
							},
						);
					if (error) return mistralErrorToWhisperingErr(error);
					return Ok(data);
				}
				case 'whispercpp': {
					return await services.transcriptions.whispercpp.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							modelPath: deviceConfig.get('transcription.whispercpp.modelPath'),
							prompt,
						},
					);
				}
				case 'parakeet': {
					return await services.transcriptions.parakeet.transcribe(
						audioToTranscribe,
						{
							modelPath: deviceConfig.get('transcription.parakeet.modelPath'),
						},
					);
				}
				case 'moonshine': {
					// Moonshine uses ONNX Runtime with encoder-decoder architecture
					// Variant is extracted from modelPath (e.g., "moonshine-tiny-en" → "tiny")
					return await services.transcriptions.moonshine.transcribe(
						audioToTranscribe,
						{
							modelPath: deviceConfig.get('transcription.moonshine.modelPath'),
						},
					);
				}
				default:
					return WhisperingErr({
						title: '⚠️ No transcription service selected',
						description: 'Please select a transcription service in settings.',
					});
			}
		})();

	// Log transcription result
	const duration = Date.now() - startTime;
	if (transcriptionResult.error) {
		analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_title: transcriptionResult.error.title,
			error_description: transcriptionResult.error.description,
		});
	} else {
		analytics.logEvent({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}
