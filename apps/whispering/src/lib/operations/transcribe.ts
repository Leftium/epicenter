import { Ok, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import { analytics } from '$lib/operations/analytics';
import { notify } from '$lib/operations/notify';
import { deepgramErrorToWhisperingErr } from '$lib/rpc/transcription-errors/deepgram';
import { elevenlabsErrorToWhisperingErr } from '$lib/rpc/transcription-errors/elevenlabs';
import { groqErrorToWhisperingErr } from '$lib/rpc/transcription-errors/groq';
import { mistralErrorToWhisperingErr } from '$lib/rpc/transcription-errors/mistral';
import { openaiErrorToWhisperingErr } from '$lib/rpc/transcription-errors/openai';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { services } from '$lib/services';
import { tauri } from '$lib/tauri';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

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
 * Transcribe an audio blob directly without any database operations.
 * Use this when you need parallel execution and will handle DB updates separately.
 */
export async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	const selectedService = settings.get('transcription.service');

	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	let audioToTranscribe = blob;
	if (tauri && settings.get('transcription.compressionEnabled')) {
		const { data: compressedBlob, error: compressionError } =
			await tauri.ffmpeg.compressAudioBlob(
				blob,
				settings.get('transcription.compressionOptions'),
			);

		if (compressionError) {
			notify.warning({
				title: 'Audio compression failed',
				description: `${compressionError.message}. Using original audio for transcription.`,
			});
			analytics.logEvent({
				type: 'compression_failed',
				provider: selectedService,
				error_message: compressionError.message,
			});
		} else {
			audioToTranscribe = compressedBlob;
			const compressionRatio = Math.round(
				(1 - compressedBlob.size / blob.size) * 100,
			);
			notify.info({
				title: 'Audio compressed',
				description: `Reduced file size by ${compressionRatio}%`,
			});
			analytics.logEvent({
				type: 'compression_completed',
				provider: selectedService,
				original_size: blob.size,
				compressed_size: compressedBlob.size,
				compression_ratio: compressionRatio,
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
					// Pure Rust audio conversion now handles most formats without FFmpeg
					// Only compressed formats (MP3, M4A) require FFmpeg, which will be
					// handled automatically as a fallback in the Rust conversion pipeline
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
					// Pure Rust audio conversion now handles most formats without FFmpeg
					// Only compressed formats (MP3, M4A) require FFmpeg, which will be
					// handled automatically as a fallback in the Rust conversion pipeline
					return await services.transcriptions.parakeet.transcribe(
						audioToTranscribe,
						{
							modelPath: deviceConfig.get('transcription.parakeet.modelPath'),
						},
					);
				}
				case 'moonshine': {
					// Moonshine uses ONNX Runtime with encoder-decoder architecture
					// Variant is extracted from modelPath (e.g., "moonshine-tiny-en" -> "tiny")
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
