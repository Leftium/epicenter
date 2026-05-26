import { invoke } from '@tauri-apps/api/core';
import { stat } from '@tauri-apps/plugin-fs';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingResult } from '$lib/result';

import type { MoonshineVariant } from './types';

/**
 * Engine-tagged config sent in the `x-transcribe-config` header of the
 * unified `transcribe_audio` Tauri command. Mirrors `TranscribeRequest`
 * on the Rust side.
 *
 * The `engine` tag values match `transcription.service` in user settings
 * so the same string flows: settings → service selector → wire → Rust
 * dispatch. The Rust enum variant is named `Whisper` but serializes as
 * `whispercpp` (see `#[serde(rename)]` in mod.rs).
 */
export type TranscribeConfig =
	| {
			engine: 'whispercpp';
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
 * User-facing display name for each engine. The wire-side `engine` tag
 * is the settings key; this is what appears in error titles like
 * "❌ Unexpected Whisper C++ Error".
 */
const ENGINE_DISPLAY_NAME: Record<TranscribeConfig['engine'], string> = {
	whispercpp: 'Whisper C++',
	parakeet: 'Parakeet',
	moonshine: 'Moonshine',
};

/**
 * Validate that `modelPath` exists and is the expected `kind`. All three
 * local services share this exact preflight (only Whisper layers a
 * file-size check on top), so it lives here. Uses a single `stat()` call
 * for both existence and kind, replacing the previous `exists()` +
 * `stat()` two-step.
 */
export async function requireExistingModelPath(
	modelPath: string,
	kind: 'file' | 'directory',
	engineDisplayName: string,
): Promise<WhisperingResult<void>> {
	const fileOrDir = kind === 'directory' ? 'Directory' : 'File';

	if (!modelPath) {
		return WhisperingErr({
			title: `📁 Model ${fileOrDir} Required`,
			description: `Please select a ${engineDisplayName} model ${kind} in settings.`,
			action: {
				type: 'link',
				label: 'Configure model',
				href: '/settings/transcription',
			},
		});
	}

	const { data: stats } = await tryAsync({
		try: () => stat(modelPath),
		catch: () => Ok(null),
	});

	if (!stats) {
		return WhisperingErr({
			title: `❌ Model ${fileOrDir} Not Found`,
			description: `The model ${kind} "${modelPath}" does not exist.`,
			action: {
				type: 'link',
				label: 'Select model',
				href: '/settings/transcription',
			},
		});
	}

	const isCorrectKind = kind === 'directory' ? stats.isDirectory : stats.isFile;
	if (!isCorrectKind) {
		return WhisperingErr({
			title: '❌ Invalid Model Path',
			description:
				kind === 'directory'
					? `${engineDisplayName} models must be directories containing model files.`
					: `${engineDisplayName} models must be a single file.`,
			action: {
				type: 'link',
				label: `Select model ${kind}`,
				href: '/settings/transcription',
			},
		});
	}

	return Ok(undefined);
}

/**
 * Single arktype schema for all errors returned by the unified
 * `transcribe_audio` command. Each engine surfaces the same four
 * variants; the only one specific to Whisper is `GpuError`, which
 * Parakeet and Moonshine never emit in practice.
 */
const LocalTranscriptionErrorType = type({
	name: "'AudioReadError' | 'GpuError' | 'ModelLoadError' | 'TranscriptionError'",
	message: 'string',
});

/**
 * Shared error mapping for the unified `transcribe_audio` command. Each
 * per-engine service used to duplicate this switch with minor copy
 * variations; the only per-engine variation is the display name, which
 * we derive from the config tag.
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
): Promise<WhisperingResult<string>> {
	const audioBuffer = await audioBlob.arrayBuffer();
	return tryAsync({
		try: () =>
			invoke<string>('transcribe_audio', audioBuffer, {
				headers: { 'x-transcribe-config': JSON.stringify(config) },
			}),
		catch: (unknownError) =>
			mapLocalTranscriptionError(
				unknownError,
				ENGINE_DISPLAY_NAME[config.engine],
			),
	});
}
