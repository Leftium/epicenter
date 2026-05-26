import { exists, stat } from '@tauri-apps/plugin-fs';
import { Ok, tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingResult } from '$lib/result';

import { transcribeLocal } from './local-transcription';
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
		audioBlob: Blob,
		options: { modelPath: string },
	): Promise<WhisperingResult<string>> {
		if (!options.modelPath) {
			return WhisperingErr({
				title: '📁 Model Directory Required',
				description: 'Please select a Parakeet model directory in settings.',
				action: {
					type: 'link',
					label: 'Configure model',
					href: '/settings/transcription',
				},
			});
		}

		const { data: isExists } = await tryAsync({
			try: () => exists(options.modelPath),
			catch: () => Ok(false),
		});

		if (!isExists) {
			return WhisperingErr({
				title: '❌ Model Directory Not Found',
				description: `The model directory "${options.modelPath}" does not exist.`,
				action: {
					type: 'link',
					label: 'Select model',
					href: '/settings/transcription',
				},
			});
		}

		const { data: stats } = await tryAsync({
			try: () => stat(options.modelPath),
			catch: () => Ok(null),
		});

		if (!stats || !stats.isDirectory) {
			return WhisperingErr({
				title: '❌ Invalid Model Path',
				description:
					'Parakeet models must be directories containing model files.',
				action: {
					type: 'link',
					label: 'Select model directory',
					href: '/settings/transcription',
				},
			});
		}

		return transcribeLocal(
			audioBlob,
			{ engine: 'parakeet', modelPath: options.modelPath },
			'Parakeet',
		);
	},
};
