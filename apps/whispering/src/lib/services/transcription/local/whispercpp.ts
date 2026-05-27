import { stat } from '@tauri-apps/plugin-fs';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

import {
	type LocalTranscriptionError,
	requireExistingModelPath,
	transcribeRecording,
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

export const WhisperCppError = defineErrors({
	CorruptedModelFile: ({
		actualSizeMb,
		expectedSizeMb,
	}: {
		actualSizeMb: number;
		expectedSizeMb: number;
	}) => ({
		message: `The model file is ${actualSizeMb}MB but should be ~${expectedSizeMb}MB. This usually happens when a download was interrupted. Please delete and re-download the model.`,
		actualSizeMb,
		expectedSizeMb,
	}),
});
export type WhisperCppError = InferErrors<typeof WhisperCppError>;

export const WhisperCppTranscriptionServiceLive = {
	async transcribe(
		recordingId: string,
		options: {
			outputLanguage: string;
			modelPath: string;
			prompt: string;
		},
	): Promise<Result<string, WhisperCppError | LocalTranscriptionError>> {
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
				return WhisperCppError.CorruptedModelFile({
					actualSizeMb: Math.round(fileStats.size / 1000000),
					expectedSizeMb: Math.round(modelConfig.sizeBytes / 1000000),
				});
			}
		}

		return transcribeRecording(recordingId, {
			engine: 'whispercpp',
			modelPath: options.modelPath,
			language:
				options.outputLanguage === 'auto' ? null : options.outputLanguage,
			initialPrompt: options.prompt || null,
		});
	},
};
