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
import { TRANSCRIPTION_SERVICES } from '$lib/services/transcription/registry';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tauri } from '$lib/tauri';

/**
 * Services that upload audio bytes to a remote endpoint (cloud APIs +
 * self-hosted). Local engines (whispercpp, parakeet, moonshine) read the
 * recording artifact from disk via the Rust `transcribe_recording`
 * command.
 */
function isUploadTranscriptionService(
	serviceId: TranscriptionServiceId,
): boolean {
	const entry = TRANSCRIPTION_SERVICES.find((s) => s.id === serviceId);
	return entry?.location === 'cloud' || entry?.location === 'self-hosted';
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
 * Materialize the bytes to upload for a cloud transcription. The recording
 * is already saved under `recordings/{id}.{ext}`; in Tauri we round-trip
 * through Rust's libopus to land on a 24 kbps voice VBR opus blob (the
 * canonical compressed-upload shape). On the web there is no Rust, so we
 * fetch the original bytes from the blob store and upload them as-is.
 */
async function loadForCloudUpload(
	recordingId: string,
): Promise<Result<Blob, WhisperingError>> {
	if (tauri) {
		const { data: oggBlob, error } =
			await tauri.audioEncoder.encodeRecordingForUpload(recordingId);
		if (!error) return Ok(oggBlob);
		notify.warning({
			title: 'Audio compression skipped',
			description: `${error.message}. Uploading uncompressed audio instead.`,
		});
		analytics.logEvent({
			type: 'compression_failed',
			provider: settings.get('transcription.service'),
			error_message: error.message,
		});
		// Fall through to the blob-store path below.
	}

	const { data: rawBlob, error: blobError } =
		await services.blobs.audio.getBlob(recordingId);
	if (blobError) {
		return WhisperingErr({
			title: '❌ Could not read recording',
			description: blobError.message,
			action: { type: 'more-details', error: blobError },
		});
	}
	return Ok(rawBlob);
}

/**
 * Transcribe a saved recording by id. This is the single canonical entry
 * point for transcription:
 *
 * - The cpal stop path saves the WAV via Rust and returns the id.
 * - The navigator / VAD / file-upload paths save the blob via the
 *   recordings blob store (which writes to the same on-disk location in
 *   Tauri, or to IndexedDB in browser builds) and pass the id here.
 *
 * Local transcription always goes through `transcribe_recording(id)`.
 * Cloud transcription uploads compressed bytes derived from the saved
 * file (Rust libopus in Tauri, raw blob in browser).
 */
export async function transcribeAudio(
	recordingId: string,
): Promise<Result<string, WhisperingError>> {
	const selectedService = settings.get('transcription.service');

	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	const result = isUploadTranscriptionService(selectedService)
		? await dispatchCloudTranscription(recordingId, selectedService)
		: await dispatchLocalTranscription(recordingId, selectedService);

	const duration = Date.now() - startTime;
	if (result.error) {
		analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_title: result.error.title,
			error_description: result.error.description,
		});
	} else {
		analytics.logEvent({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return result;
}

async function dispatchLocalTranscription(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, WhisperingError>> {
	const outputLanguage = getOutputLanguage();
	const prompt = settings.get('transcription.prompt');

	switch (selectedService) {
		case 'whispercpp':
			return services.transcriptions.whispercpp.transcribe(recordingId, {
				outputLanguage,
				modelPath: deviceConfig.get('transcription.whispercpp.modelPath'),
				prompt,
			});
		case 'parakeet':
			return services.transcriptions.parakeet.transcribe(recordingId, {
				modelPath: deviceConfig.get('transcription.parakeet.modelPath'),
			});
		case 'moonshine':
			return services.transcriptions.moonshine.transcribe(recordingId, {
				modelPath: deviceConfig.get('transcription.moonshine.modelPath'),
			});
		default:
			return WhisperingErr({
				title: '⚠️ Unknown local service',
				description: `Service "${selectedService}" was routed to local transcription but has no handler.`,
			});
	}
}

async function dispatchCloudTranscription(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, WhisperingError>> {
	const { data: audio, error: loadError } =
		await loadForCloudUpload(recordingId);
	if (loadError) return Err(loadError);

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
			return services.transcriptions.speaches.transcribe(audio, {
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
			const { data, error } =
				await services.transcriptions.mistral.transcribe(audio, {
					outputLanguage,
					prompt,
					temperature,
					apiKey: deviceConfig.get('apiKeys.mistral'),
					modelName: settings.get('transcription.mistral.model'),
				});
			if (error) return services.transcriptions.mistral.toWhisperingErr(error);
			return Ok(data);
		}
		default:
			return WhisperingErr({
				title: '⚠️ Unknown cloud service',
				description: `Service "${selectedService}" was routed to cloud transcription but has no handler.`,
			});
	}
}
