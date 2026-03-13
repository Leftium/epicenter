import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import { rpc } from '$lib/query';
import { defineMutation, queryClient } from '$lib/query/client';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { desktopServices, services } from '$lib/services';
import type { Recording } from '$lib/services/db';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { workspaceSettings } from '$lib/state/workspace-settings.svelte';
import { db } from './db';
import { notify } from './notify';

const transcriptionKeys = {
	isTranscribing: ['transcription', 'isTranscribing'] as const,
} as const;

function getOutputLanguage(): SupportedLanguage {
	const language = workspaceSettings.get('transcription.language');
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
				await services.db.recordings.getAudioBlob(recording.id);

			if (getAudioBlobError) {
				return WhisperingErr({
					title: '⚠️ Failed to fetch audio',
					description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
				});
			}

			const { error: setRecordingTranscribingError } =
				await db.recordings.update({
					...recording,
					transcriptionStatus: 'TRANSCRIBING',
				});
			if (setRecordingTranscribingError) {
				notify.warning({
					title:
						'⚠️ Unable to set recording transcription status to transcribing',
					description: 'Continuing with the transcription process...',
					action: {
						type: 'more-details',
						error: setRecordingTranscribingError,
					},
				});
			}
			const { data: transcribedText, error: transcribeError } =
				await transcribeBlob(audioBlob);
			if (transcribeError) {
				const { error: setRecordingTranscribingError } =
					await db.recordings.update({
						...recording,
						transcriptionStatus: 'FAILED',
					});
				if (setRecordingTranscribingError) {
					notify.warning({
						title: '⚠️ Unable to update recording after transcription',
						description:
							"Transcription failed but unable to update recording's transcription status in database",
						action: {
							type: 'more-details',
							error: setRecordingTranscribingError,
						},
					});
				}
				return Err(transcribeError);
			}

			const { error: setRecordingTranscribedTextError } =
				await db.recordings.update({
					...recording,
					transcribedText,
					transcriptionStatus: 'DONE',
				});
			if (setRecordingTranscribedTextError) {
				notify.warning({
					title: '⚠️ Unable to update recording after transcription',
					description:
						"Transcription completed but unable to update recording's transcribed text and status in database",
					action: {
						type: 'more-details',
						error: setRecordingTranscribedTextError,
					},
				});
			}
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
						await services.db.recordings.getAudioBlob(recording.id);

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
	const selectedService = workspaceSettings.get('transcription.service');

	// Log transcription request
	const startTime = Date.now();
	rpc.analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	// Compress audio if enabled, else pass through original blob
	let audioToTranscribe = blob;
	if (workspaceSettings.get('transcription.compressionEnabled')) {
		const { data: compressedBlob, error: compressionError } =
			await desktopServices.ffmpeg.compressAudioBlob(
				blob,
				workspaceSettings.get('transcription.compressionOptions'),
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

	const transcriptionResult: Result<string, WhisperingError> =
		await (async () => {
			const outputLanguage = getOutputLanguage();
			const prompt = workspaceSettings.get('transcription.prompt');
			const temperature = String(
				workspaceSettings.get('transcription.temperature'),
			);

			switch (selectedService) {
				case 'OpenAI':
					return await services.transcriptions.openai.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
						apiKey: deviceConfig.get("apiKeys.openai"),
							modelName: workspaceSettings.get('transcription.openai.model'),
						baseURL: deviceConfig.get("apiEndpoints.openai") || undefined,
						},
					);
				case 'Groq':
					return await services.transcriptions.groq.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
						apiKey: deviceConfig.get("apiKeys.groq"),
							modelName: workspaceSettings.get('transcription.groq.model'),
						baseURL: deviceConfig.get("apiEndpoints.groq") || undefined,
						},
					);
				case 'speaches':
					return await services.transcriptions.speaches.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
						modelId: deviceConfig.get("transcription.speaches.modelId"),
						baseUrl: deviceConfig.get("transcription.speaches.baseUrl"),
						},
					);
				case 'ElevenLabs':
					return await services.transcriptions.elevenlabs.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
						apiKey: deviceConfig.get("apiKeys.elevenlabs"),
							modelName: workspaceSettings.get(
								'transcription.elevenlabs.model',
							),
						},
					);
				case 'Deepgram':
					return await services.transcriptions.deepgram.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
						apiKey: deviceConfig.get("apiKeys.deepgram"),
							modelName: workspaceSettings.get('transcription.deepgram.model'),
						},
					);
				case 'Mistral':
					return await services.transcriptions.mistral.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							prompt,
							temperature,
						apiKey: deviceConfig.get("apiKeys.mistral"),
							modelName: workspaceSettings.get('transcription.mistral.model'),
						},
					);
				case 'whispercpp': {
					// Pure Rust audio conversion now handles most formats without FFmpeg
					// Only compressed formats (MP3, M4A) require FFmpeg, which will be
					// handled automatically as a fallback in the Rust conversion pipeline
					return await services.transcriptions.whispercpp.transcribe(
						audioToTranscribe,
						{
							outputLanguage,
							modelPath:
							deviceConfig.get("transcription.whispercpp.modelPath"),
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
						modelPath: deviceConfig.get("transcription.parakeet.modelPath"),
						},
					);
				}
				case 'moonshine': {
					// Moonshine uses ONNX Runtime with encoder-decoder architecture
					// Variant is extracted from modelPath (e.g., "moonshine-tiny-en" → "tiny")
					return await services.transcriptions.moonshine.transcribe(
						audioToTranscribe,
						{
							modelPath:
							deviceConfig.get("transcription.moonshine.modelPath"),
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
