import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import { rpc } from '$lib/query';
import { defineMutation, queryClient } from '$lib/query/client';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { services } from '$lib/services';
import { desktopServices } from '$lib/services/desktop';
import { deviceConfig } from '$lib/state/device-config.svelte';
import type { Recording } from '$lib/state/recordings.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { notify } from './notify';

const transcriptionKeys = {
	isTranscribing: ['transcription', 'isTranscribing'] as const,
} as const;

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
	rpc.analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	// Compress audio if enabled, else pass through original blob
	let audioToTranscribe = blob;
	if (settings.get('transcription.compressionEnabled')) {
		const { data: compressedBlob, error: compressionError } =
			await desktopServices.ffmpeg.compressAudioBlob(
				blob,
				settings.get('transcription.compressionOptions'),
			);

		if (compressionError) {
			// Notify user of compression failure but continue with original blob
			notify.warning({
				title: 'Audio compression failed',
				description: `${compressionError.message}. Using original audio for transcription.`,
			});
			rpc.analytics.logEvent({
				type: 'compression_failed',
				provider: selectedService,
				error_message: compressionError.message,
			});
		} else {
			// Use compressed blob and notify user of success
			audioToTranscribe = compressedBlob;
			const compressionRatio = Math.round(
				(1 - compressedBlob.size / blob.size) * 100,
			);
			notify.info({
				title: 'Audio compressed',
				description: `Reduced file size by ${compressionRatio}%`,
			});
			rpc.analytics.logEvent({
				type: 'compression_completed',
				provider: selectedService,
				original_size: blob.size,
				compressed_size: compressedBlob.size,
				compression_ratio: compressionRatio,
			});
		}
	}

	// Diagnostic: log blob state to help debug 400 "Invalid file format" errors.
	// If size is 0 or type is empty, the blob is the problem—not the extension.
	console.debug('[Transcription] Blob diagnostics:', {
		size: audioToTranscribe.size,
		type: audioToTranscribe.type,
		sizeKb: Math.round(audioToTranscribe.size / 1024),
		service: selectedService,
	});
	const transcriptionResult: Result<string, WhisperingError> =
		await (async () => {
			const outputLanguage = getOutputLanguage();
			const prompt = settings.get('transcription.prompt');
			const temperature = String(settings.get('transcription.temperature'));

			switch (selectedService) {
				case 'OpenAI': {
					const { data, error } = await services.transcriptions.openai.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
							apiKey: deviceConfig.get('apiKeys.openai'),
							modelName: settings.get('transcription.openai.model'),
							baseURL: deviceConfig.get('apiEndpoints.openai') || undefined,
						},
					);
					if (error) {
						switch (error.name) {
							case 'MissingApiKey':
								return WhisperingErr({
									title: '🔑 API Key Required',
									description:
										'Please enter your OpenAI API key in settings to use Whisper transcription.',
									action: {
										type: 'link',
										label: 'Add API key',
										href: '/settings/transcription',
									},
								});
							case 'InvalidApiKeyFormat':
								return WhisperingErr({
									title: '🔑 Invalid API Key Format',
									description:
										'Your OpenAI API key should start with "sk-". Please check and update your API key.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'FileTooLarge':
								return WhisperingErr({
									title: `The file size (${error.sizeMb.toFixed(1)}MB) is too large`,
									description: `Please upload a file smaller than ${error.maxMb}MB.`,
								});
							case 'FileCreationFailed':
								return WhisperingErr({
									title: '📁 File Creation Failed',
									description:
										'Failed to create audio file for transcription. Please try again.',
									serviceError: error,
								});
							case 'BadRequest':
								return WhisperingErr({
									title: '❌ Bad Request',
									description:
										error.message ||
										'Invalid request to OpenAI API.',
									serviceError: error,
								});
							case 'Unauthorized':
								return WhisperingErr({
									title: '🔑 Authentication Required',
									description:
										error.message ||
										'Your API key appears to be invalid or expired. Please update your API key in settings to continue transcribing.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'PermissionDenied':
								return WhisperingErr({
									title: '⛔ Permission Denied',
									description:
										error.message ||
										"Your account doesn't have access to this feature. This may be due to plan limitations or account restrictions.",
									serviceError: error,
								});
							case 'NotFound':
								return WhisperingErr({
									title: '🔍 Not Found',
									description:
										error.message ||
										'The requested resource was not found. This might indicate an issue with the model or API endpoint.',
									serviceError: error,
								});
							case 'PayloadTooLarge':
								return WhisperingErr({
									title: '📦 Audio File Too Large',
									description:
										error.message ||
										'Your audio file exceeds the maximum size limit (25MB). Try splitting it into smaller segments or reducing the audio quality.',
									serviceError: error,
								});
							case 'UnsupportedMediaType':
								return WhisperingErr({
									title: '🎵 Unsupported Format',
									description:
										error.message ||
										"This audio format isn't supported. Please convert your file to MP3, WAV, M4A, or another common audio format.",
									serviceError: error,
								});
							case 'UnprocessableEntity':
								return WhisperingErr({
									title: '⚠️ Invalid Input',
									description:
										error.message ||
										'The request was valid but the server cannot process it. Please check your audio file and parameters.',
									serviceError: error,
								});
							case 'RateLimit':
								return WhisperingErr({
									title: '⏱️ Rate Limit Reached',
									description:
										error.message || 'Too many requests. Please try again later.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'ServiceUnavailable':
								return WhisperingErr({
									title: '🔧 Service Unavailable',
									description:
										error.message ||
										`The transcription service is temporarily unavailable (Error ${error.status}). Please try again in a few minutes.`,
									serviceError: error,
								});
							case 'Connection':
								return WhisperingErr({
									title: '🌐 Connection Issue',
									description:
										error.message ||
										'Unable to connect to the OpenAI service. This could be a network issue or temporary service interruption.',
									serviceError: error,
								});
							case 'Unexpected':
								return WhisperingErr({
									title: '❌ Unexpected Error',
									description:
										error.message || 'An unexpected error occurred. Please try again.',
									serviceError: error,
								});
						}
					}
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
					if (error) {
						switch (error.name) {
							case 'MissingApiKey':
								return WhisperingErr({
									title: '🔑 API Key Required',
									description: 'Please enter your Groq API key in settings.',
									action: {
										type: 'link',
										label: 'Add API key',
										href: '/settings/transcription',
									},
								});
							case 'InvalidApiKeyFormat':
								return WhisperingErr({
									title: '🔑 Invalid API Key Format',
									description:
										'Your Groq API key should start with "gsk_" or "xai-". Please check and update your API key.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'FileTooLarge':
								return WhisperingErr({
									title: `The file size (${error.sizeMb.toFixed(1)}MB) is too large`,
									description: `Please upload a file smaller than ${error.maxMb}MB.`,
								});
							case 'FileCreationFailed':
								return WhisperingErr({
									title: '📄 File Creation Failed',
									description:
										'Failed to create audio file for transcription. Please try again.',
									serviceError: error,
								});
							case 'BadRequest':
								return WhisperingErr({
									title: '❌ Bad Request',
									description:
										error.message || 'Invalid request to Groq API.',
									serviceError: error,
								});
							case 'Unauthorized':
								return WhisperingErr({
									title: '🔑 Authentication Required',
									description:
										error.message ||
										'Your API key appears to be invalid or expired. Please update your API key in settings to continue transcribing.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'PermissionDenied':
								return WhisperingErr({
									title: '⛔ Permission Denied',
									description:
										error.message ||
										"Your account doesn't have access to this feature. This may be due to plan limitations or account restrictions.",
									serviceError: error,
								});
							case 'NotFound':
								return WhisperingErr({
									title: '🔍 Not Found',
									description:
										error.message ||
										'The requested resource was not found. This might indicate an issue with the model or API endpoint.',
									serviceError: error,
								});
							case 'UnprocessableEntity':
								return WhisperingErr({
									title: '⚠️ Invalid Input',
									description:
										error.message ||
										'The request was valid but the server cannot process it. Please check your audio file and parameters.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'RateLimit':
								return WhisperingErr({
									title: '⏱️ Rate Limit Reached',
									description:
										error.message || 'Too many requests. Please try again later.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'ServiceUnavailable':
								return WhisperingErr({
									title: '🔧 Service Unavailable',
									description:
										error.message ||
										`The transcription service is temporarily unavailable (Error ${error.status}). Please try again in a few minutes.`,
									serviceError: error,
								});
							case 'Connection':
								return WhisperingErr({
									title: '🌐 Connection Issue',
									description:
										error.message ||
										'Unable to connect to the Groq service. This could be a network issue or temporary service interruption.',
									serviceError: error,
								});
							case 'Unexpected':
								return WhisperingErr({
									title: '❌ Unexpected Error',
									description:
										error.message || 'An unexpected error occurred. Please try again.',
									serviceError: error,
								});
						}
					}
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
					if (error) {
						switch (error.name) {
							case 'MissingApiKey':
								return WhisperingErr({
									title: '🔑 API Key Required',
									description:
										'Please enter your ElevenLabs API key in settings to use speech-to-text transcription.',
									action: {
										type: 'link',
										label: 'Add API key',
										href: '/settings/transcription',
									},
								});
							case 'FileTooLarge':
								return WhisperingErr({
									title: '📁 File Size Too Large',
									description: `Your audio file (${error.sizeMb.toFixed(1)}MB) exceeds the ${error.maxMb}MB limit. Please use a smaller file or compress the audio.`,
								});
							case 'Unexpected':
								return WhisperingErr({
									title: '🔧 Transcription Failed',
									description:
										'Unable to complete the transcription using ElevenLabs. This may be due to a service issue or unsupported audio format. Please try again.',
									serviceError: error,
								});
						}
					}
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
					if (error) {
						switch (error.name) {
							case 'MissingApiKey':
								return WhisperingErr({
									title: '🔑 API Key Required',
									description:
										'Please enter your Deepgram API key in settings to use Deepgram transcription.',
									action: {
										type: 'link',
										label: 'Add API key',
										href: '/settings/transcription',
									},
								});
							case 'FileTooLarge':
								return WhisperingErr({
									title: `The file size (${error.sizeMb.toFixed(1)}MB) is too large`,
									description: `Please upload a file smaller than ${error.maxMb}MB.`,
								});
							case 'Connection':
								return WhisperingErr({
									title: '🌐 Connection Issue',
									description:
										'Unable to connect to Deepgram service. Please check your internet connection.',
									serviceError: error,
								});
							case 'BadRequest':
								return WhisperingErr({
									title: '❌ Bad Request',
									description:
										error.message ||
										'Invalid request parameters. Please check your audio file and settings.',
									serviceError: error,
								});
							case 'Unauthorized':
								return WhisperingErr({
									title: '🔑 Authentication Failed',
									description:
										'Your Deepgram API key is invalid or expired. Please update your API key in settings.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'Forbidden':
								return WhisperingErr({
									title: '⛔ Access Denied',
									description:
										error.message ||
										'Your account does not have access to this feature or model.',
									serviceError: error,
								});
							case 'PayloadTooLarge':
								return WhisperingErr({
									title: '📦 Audio File Too Large',
									description:
										'Your audio file exceeds the maximum size limit. Try splitting it into smaller segments.',
									serviceError: error,
								});
							case 'UnsupportedMediaType':
								return WhisperingErr({
									title: '🎵 Unsupported Format',
									description:
										"This audio format isn't supported. Please convert your file to a supported format.",
									serviceError: error,
								});
							case 'RateLimit':
								return WhisperingErr({
									title: '⏱️ Rate Limit Reached',
									description:
										'Too many requests. Please wait before trying again.',
									serviceError: error,
								});
							case 'ServiceUnavailable':
								return WhisperingErr({
									title: '🔧 Service Unavailable',
									description: `The Deepgram service is temporarily unavailable (Error ${error.status}). Please try again later.`,
									serviceError: error,
								});
							case 'Parse':
								return WhisperingErr({
									title: '🔍 Response Error',
									description:
										'Received an unexpected response from Deepgram service. Please try again.',
									serviceError: error,
								});
							case 'NoTranscriptDetected':
								return WhisperingErr({
									title: '📝 No Transcription Found',
									description:
										'No speech was detected in the audio file. Please check your audio and try again.',
								});
							case 'Unexpected':
								return WhisperingErr({
									title: '❓ Unexpected Error',
									description:
										'An unexpected error occurred during transcription. Please try again.',
									serviceError: error,
								});
						}
					}
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
					if (error) {
						switch (error.name) {
							case 'MissingApiKey':
								return WhisperingErr({
									title: '🔑 API Key Required',
									description: 'Please enter your Mistral API key in settings.',
									action: {
										type: 'link',
										label: 'Add API key',
										href: '/settings/transcription',
									},
								});
							case 'FileTooLarge':
								return WhisperingErr({
									title: `The file size (${error.sizeMb.toFixed(1)}MB) is too large`,
									description: `Please upload a file smaller than ${error.maxMb}MB.`,
								});
							case 'FileCreationFailed':
								return WhisperingErr({
									title: '📄 File Creation Failed',
									description:
										'Failed to create audio file for transcription. Please try again.',
									serviceError: error,
								});
							case 'Unauthorized':
								return WhisperingErr({
									title: '🔑 Authentication Required',
									description:
										'Your API key appears to be invalid or expired. Please update your API key in settings.',
									action: {
										type: 'link',
										label: 'Update API key',
										href: '/settings/transcription',
									},
								});
							case 'RateLimit':
								return WhisperingErr({
									title: '⏱️ Rate Limit Reached',
									description: 'Too many requests. Please try again later.',
									serviceError: error,
								});
							case 'PayloadTooLarge':
								return WhisperingErr({
									title: '📦 Audio File Too Large',
									description:
										'Your audio file exceeds the maximum size limit. Try reducing the file size.',
									serviceError: error,
								});
							case 'BadRequest':
								return WhisperingErr({
									title: '❌ Bad Request',
									description:
										error.message ||
										'Invalid request parameters. Please check your audio file and settings.',
									serviceError: error,
								});
							case 'ServiceUnavailable':
								return WhisperingErr({
									title: '🔧 Service Unavailable',
									description: `The Mistral service is temporarily unavailable (Error ${error.status}). Please try again later.`,
									serviceError: error,
								});
							case 'InvalidResponse':
								return WhisperingErr({
									title: '❌ Invalid Transcription Response',
									description: 'Mistral API returned an invalid response format.',
								});
							case 'Unexpected':
								return WhisperingErr({
									title: '❌ Transcription Failed',
									description: error.message,
									serviceError: error,
								});
						}
					}
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
		rpc.analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_title: transcriptionResult.error.title,
			error_description: transcriptionResult.error.description,
		});
	} else {
		rpc.analytics.logEvent({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}
