import { stat } from '@tauri-apps/plugin-fs';
import { type AnyTaggedError, defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import {
	isModelFileSizeValid,
	WHISPER_MODELS,
} from '$lib/constants/local-models';
import type { TranscriptionServiceId } from '$lib/constants/transcription';
import { analytics } from '$lib/operations/analytics';
import { report } from '$lib/report';
import { services } from '$lib/services';
import {
	LocalPreflightError,
	requireExistingModelPath,
} from '$lib/services/transcription/local-preflight';
import { TRANSCRIPTION_SERVICES } from '$lib/services/transcription/registry';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tauri } from '$lib/tauri';
import { commands } from '$lib/tauri/commands';

export type TranscriptionError = AnyTaggedError;

const TranscriptionOperationError = defineErrors({
	NoTranscriptionServiceSelected: () => ({
		message: 'Please select a transcription service in settings.',
	}),
});

/**
 * Services that upload audio bytes to a remote endpoint. Local engines read
 * the recording artifact from disk via the Rust `transcribe_recording`
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
 * through Rust's libopus to land on a compressed opus blob. On the web
 * there is no Rust, so we fetch the original bytes from the blob store and
 * upload them as-is.
 */
async function loadForCloudUpload(
	recordingId: string,
): Promise<Result<Blob, TranscriptionError>> {
	if (tauri) {
		const { data: oggBytes, error } =
			await commands.encodeRecordingForUpload(recordingId);
		if (error === null) return Ok(new Blob([oggBytes], { type: 'audio/ogg' }));
		report.info({
			title: 'Audio compression skipped',
			description: `${error}. Uploading uncompressed audio instead.`,
		});
		analytics.logEvent({
			type: 'compression_failed',
			provider: settings.get('transcription.service'),
			error_message: error,
		});
	}

	const { data: rawBlob, error: blobError } =
		await services.blobs.audio.getBlob(recordingId);
	if (blobError) return Err(blobError);
	return Ok(rawBlob);
}

/**
 * Transcribe a saved recording by id. This is the single canonical entry
 * point for transcription:
 *
 * - The cpal stop path saves the WAV via Rust and returns the id.
 * - The navigator / VAD / file-upload paths save the blob via the
 *   recordings blob store and pass the id here.
 *
 * Local transcription always goes through `transcribe_recording(id)`.
 * Cloud transcription uploads compressed bytes derived from the saved file
 * when possible, falling back to the raw blob.
 */
export async function transcribeAudio(
	recordingId: string,
): Promise<Result<string, TranscriptionError>> {
	const selectedService = settings.get('transcription.service');

	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	const transcriptionResult = isUploadTranscriptionService(selectedService)
		? await dispatchCloudTranscription(recordingId, selectedService)
		: await dispatchLocalTranscription(recordingId, selectedService);

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

async function dispatchLocalTranscription(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, TranscriptionError>> {
	// FE preflight: every local engine needs a model path on disk. Rust will
	// also fail loudly via `ModelLoadError`, but checking here lets us return
	// a much better error message (per-engine display name, file vs directory
	// guidance) and short-circuit before round-tripping through the IPC.
	switch (selectedService) {
		case 'whispercpp': {
			const modelPath = deviceConfig.get('transcription.whispercpp.modelPath');
			const validation = await requireExistingModelPath(
				modelPath,
				'file',
				'Whisper C++',
			);
			if (validation.error) return validation;

			// Whisper-specific: an interrupted download still loads but produces
			// garbage transcripts. Only files we recognize from WHISPER_MODELS
			// have an expected size to compare against.
			const modelConfig = WHISPER_MODELS.find((m) =>
				modelPath.endsWith(m.file.filename),
			);
			if (modelConfig) {
				const { data: fileStats } = await tryAsync({
					try: () => stat(modelPath),
					catch: () => Ok(null),
				});
				if (
					fileStats &&
					!isModelFileSizeValid(fileStats.size, modelConfig.sizeBytes)
				) {
					return LocalPreflightError.CorruptedModelFile({
						actualSizeMb: Math.round(fileStats.size / 1000000),
						expectedSizeMb: Math.round(modelConfig.sizeBytes / 1000000),
					});
				}
			}
			break;
		}
		case 'parakeet': {
			const modelPath = deviceConfig.get('transcription.parakeet.modelPath');
			const validation = await requireExistingModelPath(
				modelPath,
				'directory',
				'Parakeet',
			);
			if (validation.error) return validation;
			break;
		}
		case 'moonshine': {
			// Directory-name validation (must end with moonshine-{variant}-{lang})
			// is owned by Rust now: `parse_moonshine_variant` returns a
			// structured `ConfigError` when the name is malformed. Keeping the
			// existence check here for the same UX-message reason as the other
			// engines.
			const modelPath = deviceConfig.get('transcription.moonshine.modelPath');
			const validation = await requireExistingModelPath(
				modelPath,
				'directory',
				'Moonshine',
			);
			if (validation.error) return validation;
			break;
		}
		default:
			return TranscriptionOperationError.NoTranscriptionServiceSelected();
	}

	// Rust reads engine, modelPath, language, prompt, and unloadPolicy from
	// the ambient config pushed via `setTranscriptionConfig` in the layout
	// effect. Anything that affects inference output is already there.
	return commands.transcribeRecording(recordingId);
}

async function dispatchCloudTranscription(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, TranscriptionError>> {
	const { data: audio, error: loadError } =
		await loadForCloudUpload(recordingId);
	if (loadError) return Err(loadError);

	const outputLanguage = getOutputLanguage();
	const prompt = settings.get('transcription.prompt');

	switch (selectedService) {
		case 'OpenAI': {
			const { data, error } = await services.transcriptions.openai.transcribe(
				audio,
				{
					outputLanguage,
					prompt,
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
					apiKey: deviceConfig.get('apiKeys.mistral'),
					modelName: settings.get('transcription.mistral.model'),
				},
			);
			if (error) return Err(error);
			return Ok(data);
		}
		default:
			return TranscriptionOperationError.NoTranscriptionServiceSelected();
	}
}
