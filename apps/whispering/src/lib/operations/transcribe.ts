import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import type { TranscriptionServiceId } from '$lib/constants/transcription';
import { analytics } from '$lib/operations/analytics';
import { notify } from '$lib/operations/notify';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { services } from '$lib/services';
import { artifactToBlob } from '$lib/services/recorder/artifact';
import type { AudioArtifact } from '$lib/services/recorder/types';
import { TRANSCRIPTION_SERVICES } from '$lib/services/transcription/registry';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tauri } from '$lib/tauri';

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
 * Heuristic that catches WAV blobs (the longform `File` artifact form
 * after `pathToBlob`, plus any legacy WAV inputs). The Opus encoder
 * rejects non-WAV input anyway; this avoids paying the IPC round-trip
 * when we already know the blob is something else.
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
 * Pick the cheapest valid Blob shape for a given service + artifact.
 *
 * Cloud / self-hosted services want compressed bytes for upload:
 * `Pcm` artifacts go straight through libopus (one encode hop, no
 * container synthesis), `Blob` artifacts that look like WAV go through
 * the WAV-bytes encoder (one decode + one encode). Local engines decode
 * the blob in-process via Symphonia, so we just materialize whichever
 * Blob is nearest.
 */
async function prepareForService(
	artifact: AudioArtifact,
	service: TranscriptionServiceId,
): Promise<Result<Blob, WhisperingError>> {
	const isUpload = isUploadTranscriptionService(service);

	// Fast path: Pcm + cloud upload. One opus encode, no WAV synthesis.
	if (isUpload && tauri && artifact.kind === 'pcm') {
		const { data: oggBlob, error } = await tauri.audioEncoder.encodePcmToOpusOgg({
			samples: artifact.samples,
			rate: artifact.rate,
			channels: artifact.channels,
		});
		if (error) {
			notify.warning({
				title: 'Audio compression skipped',
				description: `${error.message}. Uploading uncompressed audio instead.`,
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
				original_size: artifact.samples.byteLength,
				compressed_size: oggBlob.size,
				compression_ratio: Math.round(
					(1 - oggBlob.size / artifact.samples.byteLength) * 100,
				),
			});
			return Ok(oggBlob);
		}
	}

	const { data: blob, error: blobError } = await artifactToBlob(artifact);
	if (blobError) {
		return WhisperingErr({
			title: '⚠️ Failed to read recording',
			description: blobError.message,
		});
	}

	// WAV uploads (VAD captures, file uploads, history re-transcribes
	// that came from a Pcm artifact's synthesized WAV): still worth
	// compressing for cloud.
	if (isUpload && tauri && blobLooksLikeWav(blob)) {
		const { data: oggBlob, error: encodeError } =
			await tauri.audioEncoder.encodeWavToOpusOgg(blob);
		if (encodeError) {
			notify.warning({
				title: 'Audio compression skipped',
				description: `${encodeError.message}. Uploading original audio instead.`,
			});
			analytics.logEvent({
				type: 'compression_failed',
				provider: service,
				error_message: encodeError.message,
			});
			return Ok(blob);
		}
		analytics.logEvent({
			type: 'compression_completed',
			provider: service,
			original_size: blob.size,
			compressed_size: oggBlob.size,
			compression_ratio: Math.round((1 - oggBlob.size / blob.size) * 100),
		});
		return Ok(oggBlob);
	}

	return Ok(blob);
}

/**
 * Transcribe an audio artifact through the configured service. This is
 * the canonical entry point for recorder output. Cloud transcription of
 * a `Pcm` artifact skips the WAV synthesis + decode roundtrip entirely;
 * a `File` artifact takes the same encode-from-WAV path as before; a
 * `Blob` artifact (navigator + file upload) passes through unchanged.
 */
export async function transcribeArtifact(
	artifact: AudioArtifact,
): Promise<Result<string, WhisperingError>> {
	const selectedService = settings.get('transcription.service');

	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	const { data: audioToTranscribe, error: prepareError } =
		await prepareForService(artifact, selectedService);
	if (prepareError) return Err(prepareError);

	const transcriptionResult = await dispatchTranscription(
		audioToTranscribe,
		selectedService,
	);

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

/**
 * Transcribe a pre-existing Blob. Kept for the history re-transcribe
 * path (`services.blobs.audio.getBlob` returns a Blob) and the file
 * upload UI. Internally wraps the Blob as a `kind: 'blob'` artifact and
 * routes through `transcribeArtifact`.
 */
export async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	return transcribeArtifact({ kind: 'blob', blob });
}

async function dispatchTranscription(
	audio: Blob,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, WhisperingError>> {
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
			if (error) return services.transcriptions.openai.toWhisperingErr(error);
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
			if (error) return services.transcriptions.groq.toWhisperingErr(error);
			return Ok(data);
		}
		case 'speaches':
			return await services.transcriptions.speaches.transcribe(audio, {
				outputLanguage,
				prompt,
				temperature,
				modelId: deviceConfig.get('transcription.speaches.modelId'),
				baseUrl: deviceConfig.get('transcription.speaches.baseUrl'),
			});
		case 'ElevenLabs': {
			const { data, error } =
				await services.transcriptions.elevenlabs.transcribe(audio, {
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.elevenlabs'),
					modelName: settings.get('transcription.elevenlabs.model'),
				});
			if (error)
				return services.transcriptions.elevenlabs.toWhisperingErr(error);
			return Ok(data);
		}
		case 'Deepgram': {
			const { data, error } =
				await services.transcriptions.deepgram.transcribe(audio, {
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.deepgram'),
					modelName: settings.get('transcription.deepgram.model'),
				});
			if (error)
				return services.transcriptions.deepgram.toWhisperingErr(error);
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
			if (error) return services.transcriptions.mistral.toWhisperingErr(error);
			return Ok(data);
		}
		case 'whispercpp': {
			return await services.transcriptions.whispercpp.transcribe(audio, {
				outputLanguage,
				modelPath: deviceConfig.get('transcription.whispercpp.modelPath'),
				prompt,
			});
		}
		case 'parakeet': {
			return await services.transcriptions.parakeet.transcribe(audio, {
				modelPath: deviceConfig.get('transcription.parakeet.modelPath'),
			});
		}
		case 'moonshine': {
			return await services.transcriptions.moonshine.transcribe(audio, {
				modelPath: deviceConfig.get('transcription.moonshine.modelPath'),
			});
		}
		default:
			return WhisperingErr({
				title: '⚠️ No transcription service selected',
				description: 'Please select a transcription service in settings.',
			});
	}
}
