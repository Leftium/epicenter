import { invoke } from '@tauri-apps/api/core';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingResult } from '$lib/result';

import type { MoonshineVariant } from './types';

/**
 * Engine-tagged config sent in the `x-transcribe-config` header of the
 * unified `transcribe_audio` Tauri command. Mirrors `TranscribeRequest`
 * on the Rust side.
 */
export type TranscribeConfig =
	| {
			engine: 'whisper';
			modelPath: string;
			language: string | null;
			initialPrompt: string | null;
	  }
	| {
			engine: 'parakeet';
			modelPath: string;
	  }
	| {
			engine: 'moonshine';
			modelPath: string;
			variant: MoonshineVariant;
	  };

/**
 * Single arktype schema for all errors returned by the unified
 * `transcribe_audio` command. Each engine surfaces the same five
 * variants; the only one specific to Whisper is `GpuError`, which
 * Parakeet and Moonshine never emit in practice.
 */
const LocalTranscriptionErrorType = type({
	name: "'AudioReadError' | 'FfmpegNotFoundError' | 'GpuError' | 'ModelLoadError' | 'TranscriptionError'",
	message: 'string',
});

/**
 * Shared error mapping for the unified `transcribe_audio` command.
 * Each per-engine service used to duplicate this switch with ~minor
 * copy variations; the variations are kept by passing an
 * `engineDisplayName` so user-facing titles still read "Whisper C++
 * Error" vs "Parakeet Error" vs "Moonshine Error".
 */
function mapLocalTranscriptionError(
	unknownError: unknown,
	engineDisplayName: string,
): WhisperingResult<never> {
	const parsed = LocalTranscriptionErrorType(unknownError);
	if (parsed instanceof type.errors) {
		return WhisperingErr({
			title: `❌ Unexpected ${engineDisplayName} Error`,
			description: extractErrorMessage(unknownError),
			action: { type: 'more-details', error: unknownError },
		});
	}

	switch (parsed.name) {
		case 'ModelLoadError':
			return WhisperingErr({
				title: '🤖 Model Loading Error',
				description: parsed.message,
				action: {
					type: 'more-details',
					error: new Error(parsed.message),
				},
			});

		case 'GpuError':
			return WhisperingErr({
				title: '🎮 GPU Error',
				description: parsed.message,
				action: {
					type: 'link',
					label: 'Configure settings',
					href: '/settings/transcription',
				},
			});

		case 'FfmpegNotFoundError':
			return WhisperingErr({
				title: '🛠️ FFmpeg Required for This Recording Format',
				description:
					'This recording is in a compressed format (webm/ogg/mp4) that requires FFmpeg. Install FFmpeg or switch to CPAL recording (which produces WAV files that work without FFmpeg).',
				action: {
					type: 'link',
					label: 'Install FFmpeg',
					href: '/install-ffmpeg',
				},
			});

		case 'AudioReadError':
			return WhisperingErr({
				title: '🔊 Audio Read Error',
				description: parsed.message,
				action: {
					type: 'more-details',
					error: new Error(parsed.message),
				},
			});

		case 'TranscriptionError':
			return WhisperingErr({
				title: '❌ Transcription Error',
				description: parsed.message,
				action: {
					type: 'more-details',
					error: new Error(parsed.message),
				},
			});
	}
}

/**
 * Send `audioBlob` and `config` to the unified `transcribe_audio` Tauri
 * command. Audio travels as the raw IPC body (no JSON-array-of-bytes
 * overhead); the config goes in the `x-transcribe-config` header as JSON.
 */
export async function transcribeLocal(
	audioBlob: Blob,
	config: TranscribeConfig,
	engineDisplayName: string,
): Promise<WhisperingResult<string>> {
	const audioBuffer = await audioBlob.arrayBuffer();
	return tryAsync({
		try: () =>
			invoke<string>('transcribe_audio', audioBuffer, {
				headers: { 'x-transcribe-config': JSON.stringify(config) },
			}),
		catch: (unknownError) =>
			mapLocalTranscriptionError(unknownError, engineDisplayName),
	});
}
