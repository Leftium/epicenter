import type { Result } from 'wellcrafted/result';

import {
	type LocalTranscriptionError,
	requireExistingModelPath,
	transcribeRecording,
} from './local-transcription';
import type { ParakeetModelConfig } from './types';

/**
 * Pre-built Parakeet models available for download from GitHub releases.
 * These are NVIDIA NeMo models consisting of multiple ONNX files.
 */
export const PARAKEET_MODELS = [
	{
		id: 'parakeet-tdt-0.6b-v3-int8',
		name: 'Parakeet TDT 0.6B v3 (INT8)',
		description: 'Fast and accurate NVIDIA NeMo model',
		size: '~670 MB',
		sizeBytes: 670_619_803,
		engine: 'parakeet',
		directoryName: 'parakeet-tdt-0.6b-v3-int8',
		files: [
			{
				url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/config.json',
				filename: 'config.json',
				sizeBytes: 97,
			},
			{
				url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/decoder_joint-model.int8.onnx',
				filename: 'decoder_joint-model.int8.onnx',
				sizeBytes: 18_202_004,
			},
			{
				url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/encoder-model.int8.onnx',
				filename: 'encoder-model.int8.onnx',
				sizeBytes: 652_183_999,
			},
			{
				url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/nemo128.onnx',
				filename: 'nemo128.onnx',
				sizeBytes: 139_764,
			},
			{
				url: 'https://github.com/EpicenterHQ/epicenter/releases/download/models/parakeet-tdt-0.6b-v3-int8/vocab.txt',
				filename: 'vocab.txt',
				sizeBytes: 93_939,
			},
		],
	},
] as const satisfies readonly ParakeetModelConfig[];

export const ParakeetTranscriptionServiceLive = {
	async transcribe(
		recordingId: string,
		options: { modelPath: string },
	): Promise<Result<string, LocalTranscriptionError>> {
		const validation = await requireExistingModelPath(
			options.modelPath,
			'directory',
			'Parakeet',
		);
		if (validation.error) return validation;

		return transcribeRecording(recordingId, {
			engine: 'parakeet',
			modelPath: options.modelPath,
		});
	},
};
