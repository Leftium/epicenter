import { stat } from '@tauri-apps/plugin-fs';
import { Ok, tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingResult } from '$lib/result';

import {
	requireExistingModelPath,
	transcribeLocal,
} from './local-transcription';
import { isModelFileSizeValid, type WhisperModelConfig } from './types';

/**
 * Pre-built Whisper models available for download from Hugging Face.
 * These are ggml-format models compatible with whisper.cpp.
 */
export const WHISPER_MODELS = [
	{
		id: 'tiny',
		name: 'Tiny',
		description: 'Fastest, basic accuracy',
		size: '78 MB',
		sizeBytes: 77_691_713,
		engine: 'whispercpp',
		file: {
			url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
			filename: 'ggml-tiny.bin',
		},
	},
	{
		id: 'small',
		name: 'Small',
		description: 'Fast, good accuracy',
		size: '488 MB',
		sizeBytes: 487_601_967,
		engine: 'whispercpp',
		file: {
			url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
			filename: 'ggml-small.bin',
		},
	},
	{
		id: 'medium',
		name: 'Medium',
		description: 'Balanced speed & accuracy',
		size: '1.5 GB',
		sizeBytes: 1_533_763_059,
		engine: 'whispercpp',
		file: {
			url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
			filename: 'ggml-medium.bin',
		},
	},
	{
		id: 'large-v3-turbo',
		name: 'Large v3 Turbo',
		description: 'Best accuracy, slower',
		size: '1.6 GB',
		sizeBytes: 1_624_555_275,
		engine: 'whispercpp',
		file: {
			url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
			filename: 'ggml-large-v3-turbo.bin',
		},
	},
] as const satisfies readonly WhisperModelConfig[];

export const WhisperCppTranscriptionService = {
	async transcribe(
		audioBlob: Blob,
		options: {
			outputLanguage: string;
			modelPath: string;
			prompt: string;
		},
	): Promise<WhisperingResult<string>> {
		const validation = await requireExistingModelPath(
			options.modelPath,
			'file',
			'Whisper C++',
		);
		if (validation.error) return validation;

		// Whisper-specific: warn on truncated downloads (incomplete model files
		// load successfully but produce garbage transcripts). Only files we
		// recognize from WHISPER_MODELS have an expected size to compare against.
		const modelConfig = WHISPER_MODELS.find((m) =>
			options.modelPath.endsWith(m.file.filename),
		);
		if (modelConfig) {
			const { data: fileStats } = await tryAsync({
				try: () => stat(options.modelPath),
				catch: () => Ok(null),
			});
			if (
				fileStats &&
				!isModelFileSizeValid(fileStats.size, modelConfig.sizeBytes)
			) {
				return WhisperingErr({
					title: '⚠️ Model File Appears Corrupted',
					description: `The model file is ${Math.round(fileStats.size / 1000000)}MB but should be ~${Math.round(modelConfig.sizeBytes / 1000000)}MB. This usually happens when a download was interrupted. Please delete and re-download the model.`,
					action: {
						type: 'link',
						label: 'Re-download model',
						href: '/settings/transcription',
					},
				});
			}
		}

		return transcribeLocal(audioBlob, {
			engine: 'whispercpp',
			modelPath: options.modelPath,
			language:
				options.outputLanguage === 'auto' ? null : options.outputLanguage,
			initialPrompt: options.prompt || null,
		});
	},
};
