import { type AnyTaggedError, defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import type { TranscriptionServiceId } from '$lib/constants/transcription';
import { analytics } from '$lib/operations/analytics';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { pcmToWavBlob } from '$lib/services/recorder/pcm-to-wav';
import type { RecorderAudio } from '$lib/services/recorder/types';
import { TRANSCRIPTION_SERVICES } from '$lib/services/transcription/registry';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tauri } from '$lib/tauri';

export type TranscriptionError = AnyTaggedError;

const TranscriptionOperationError = defineErrors({
	NoTranscriptionServiceSelected: () => ({
		message: 'Please select a transcription service in settings.',
	}),
});

/**
 * Services that upload audio bytes to a remote endpoint (cloud APIs +
 * self-hosted). The local engines (whispercpp, parakeet, moonshine) decode
 * the blob in-process via the Rust decoder, so compressing their input
 * would just round-trip through libopus for no win.
 */
function isUploadTranscriptionService(
	serviceId: TranscriptionServiceId,
): boolean {
	const entry = TRANSCRIPTION_SERVICES.find((s) => s.id === serviceId);
	return entry?.location === 'cloud' || entry?.location === 'self-hosted';
}

/**
 * Heuristic that catches WAV blobs from synthesized PCM, VAD captures,
 * file uploads, history replays, and legacy WAV inputs. The Opus encoder
 * rejects non-WAV input anyway; this avoids paying the IPC round-trip when
 * we already know the blob is something else.
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

/**
 * Pick the cheapest valid Blob shape for a given service + audio payload.
 *
 * Cloud / self-hosted services want compressed bytes for upload: PCM
 * (Float32Array) goes straight through libopus (one encode hop, no
 * container synthesis), Blob payloads that look like WAV go through the
 * WAV-bytes encoder (one decode + one encode). Local engines decode the
 * blob in-process via Symphonia, so we just materialize whichever Blob
 * is nearest.
 */
async function prepareForService(
	audio: RecorderAudio,
	service: TranscriptionServiceId,
): Promise<Blob> {
	const isUpload = isUploadTranscriptionService(service);

	// Fast path: PCM + cloud upload. One opus encode, no WAV synthesis.
	if (isUpload && tauri && audio instanceof Float32Array) {
		const { data: oggBlob, error } =
			await tauri.audioEncoder.encodePcmToOpusOgg(audio);
		if (error) {
			report.info({
				title: 'Audio compression skipped',
				description: `${error.message}. Uploading uncompressed audio instead.`,
				cause: error,
			});
			analytics.logEvent({
				type: 'compression_failed',
				provider: service,
				error_message: error.message,
			});
			// Fall through to the WAV-blob path below.
		} else {
			analytics.logEvent({
				type: 'compression_completed',
				provider: service,
				original_size: audio.byteLength,
				compressed_size: oggBlob.size,
				compression_ratio: Math.round(
					(1 - oggBlob.size / audio.byteLength) * 100,
				),
			});
			return oggBlob;
		}
	}

	const blob = audio instanceof Blob ? audio : pcmToWavBlob(audio);

	// WAV uploads and synthesized PCM blobs are still worth compressing
	// for cloud transcription.
	if (isUpload && tauri && blobLooksLikeWav(blob)) {
		const { data: oggBlob, error: encodeError } =
			await tauri.audioEncoder.encodeWavToOpusOgg(blob);
		if (encodeError) {
			report.info({
				title: 'Audio compression skipped',
				description: `${encodeError.message}. Uploading original audio instead.`,
				cause: encodeError,
			});
			analytics.logEvent({
				type: 'compression_failed',
				provider: service,
				error_message: encodeError.message,
			});
			return blob;
		}
		analytics.logEvent({
			type: 'compression_completed',
			provider: service,
			original_size: blob.size,
			compressed_size: oggBlob.size,
			compression_ratio: Math.round((1 - oggBlob.size / blob.size) * 100),
		});
		return oggBlob;
	}

	return blob;
}

/**
 * Transcribe a recorder audio payload through the configured service.
 * This is the canonical entry point for recorder output. Cloud
 * transcription of an in-memory PCM payload skips the WAV synthesis +
 * decode roundtrip entirely; a Blob payload (navigator, VAD, file
 * upload, history replay) passes through unchanged unless it is a WAV
 * blob for an upload service.
 */
export async function transcribeAudio(
	audio: RecorderAudio,
): Promise<Result<string, TranscriptionError>> {
	const selectedService = settings.get('transcription.service');

	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	const audioToTranscribe = await prepareForService(audio, selectedService);
	const transcriptionResult = await dispatchTranscription(
		audioToTranscribe,
		selectedService,
	);

	const duration = Date.now() - startTime;
	if (transcriptionResult.error) {
		analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_name: transcriptionResult.error.name,
			error_message: transcriptionResult.error.message,
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

async function dispatchTranscription(
	audio: Blob,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, TranscriptionError>> {
	const outputLanguage = getOutputLanguage();
	const prompt = settings.get('transcription.prompt');
	const temperature = String(settings.get('transcription.temperature'));

	switch (selectedService) {
		case 'OpenAI': {
			const { data, error } = await services.transcriptions.openai.transcribe(
				audio,
				{
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.openai'),
					modelName: settings.get('transcription.openai.model'),
					baseURL: deviceConfig.get('apiEndpoints.openai') || undefined,
				},
			);
			if (error) return Err(error);
			return Ok(data);
		}
		case 'Groq': {
			const { data, error } = await services.transcriptions.groq.transcribe(
				audio,
				{
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.groq'),
					modelName: settings.get('transcription.groq.model'),
					baseURL: deviceConfig.get('apiEndpoints.groq') || undefined,
				},
			);
			if (error) return Err(error);
			return Ok(data);
		}
		case 'speaches': {
			const { data: speachesData, error: speachesError } =
				await services.transcriptions.speaches.transcribe(audio, {
					outputLanguage,
					prompt,
					temperature,
					modelId: deviceConfig.get('transcription.speaches.modelId'),
					baseUrl: deviceConfig.get('transcription.speaches.baseUrl'),
				});
			if (speachesError) return Err(speachesError);
			return Ok(speachesData);
		}
		case 'ElevenLabs': {
			const { data, error } =
				await services.transcriptions.elevenlabs.transcribe(audio, {
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.elevenlabs'),
					modelName: settings.get('transcription.elevenlabs.model'),
				});
			if (error) return Err(error);
			return Ok(data);
		}
		case 'Deepgram': {
			const { data, error } = await services.transcriptions.deepgram.transcribe(
				audio,
				{
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.deepgram'),
					modelName: settings.get('transcription.deepgram.model'),
				},
			);
			if (error) return Err(error);
			return Ok(data);
		}
		case 'Mistral': {
			const { data, error } = await services.transcriptions.mistral.transcribe(
				audio,
				{
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.mistral'),
					modelName: settings.get('transcription.mistral.model'),
				},
			);
			if (error) return Err(error);
			return Ok(data);
		}
		case 'whispercpp': {
			const { data, error } =
				await services.transcriptions.whispercpp.transcribe(audio, {
					outputLanguage,
					modelPath: deviceConfig.get('transcription.whispercpp.modelPath'),
					prompt,
				});
			if (error) {
				return Err(error);
			}
			return Ok(data);
		}
		case 'parakeet': {
			const { data, error } = await services.transcriptions.parakeet.transcribe(
				audio,
				{
					modelPath: deviceConfig.get('transcription.parakeet.modelPath'),
				},
			);
			if (error) {
				return Err(error);
			}
			return Ok(data);
		}
		case 'moonshine': {
			const { data, error } =
				await services.transcriptions.moonshine.transcribe(audio, {
					modelPath: deviceConfig.get('transcription.moonshine.modelPath'),
				});
			if (error) {
				return Err(error);
			}
			return Ok(data);
		}
		default:
			return TranscriptionOperationError.NoTranscriptionServiceSelected();
	}
}
