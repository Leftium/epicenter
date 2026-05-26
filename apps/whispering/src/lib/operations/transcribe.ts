import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import { analytics } from '$lib/operations/analytics';
import { notify } from '$lib/operations/notify';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { deepgramErrorToWhisperingErr } from '$lib/rpc/transcription-errors/deepgram';
import { elevenlabsErrorToWhisperingErr } from '$lib/rpc/transcription-errors/elevenlabs';
import { groqErrorToWhisperingErr } from '$lib/rpc/transcription-errors/groq';
import { mistralErrorToWhisperingErr } from '$lib/rpc/transcription-errors/mistral';
import { openaiErrorToWhisperingErr } from '$lib/rpc/transcription-errors/openai';
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
function isUploadTranscriptionService(serviceId: TranscriptionService): boolean {
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
 * Cloud / self-hosted services want compressed bytes for upload; we
 * encode straight from `Pcm` samples via libopus, falling back to the
 * WAV-bytes encoder for `File` and `Blob` artifacts that already have
 * container bytes. Local engines decode the blob in-process; we hand
 * them whatever's nearest (WAV-wrapped PCM, the original file as a
 * blob, or the original navigator blob).
 */
type TranscriptionService = ReturnType<
	typeof settings.get<'transcription.service'>
>;

async function prepareForService(
	artifact: AudioArtifact,
	service: TranscriptionService,
): Promise<Result<Blob, WhisperingError>> {
	const isUpload = isUploadTranscriptionService(service);

	// Fast path: dictation Pcm + cloud upload. One Opus encode hop, no
	// container synthesis, no Symphonia decode.
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

	// Materialize a Blob for the remaining cases.
	const { data: blob, error: blobError } = await artifactToBlob(artifact);
	if (blobError) {
		return WhisperingErr({
			title: '⚠️ Failed to read recording',
			description: blobError.message,
		});
	}

	// Longform File artifact uploading to cloud: still worth compressing.
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
	selectedService: TranscriptionService,
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
			if (error) return openaiErrorToWhisperingErr(error);
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
			if (error) return groqErrorToWhisperingErr(error);
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
			if (error) return elevenlabsErrorToWhisperingErr(error);
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
			if (error) return deepgramErrorToWhisperingErr(error);
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
			if (error) return mistralErrorToWhisperingErr(error);
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
