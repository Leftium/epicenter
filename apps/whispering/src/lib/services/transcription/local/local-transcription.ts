import { invoke } from '@tauri-apps/api/core';
import { stat } from '@tauri-apps/plugin-fs';
import { type } from 'arktype';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

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

export const LocalTranscriptionError = defineErrors({
	ModelPathRequired: ({
		engineDisplayName,
		kind,
	}: {
		engineDisplayName: string;
		kind: 'file' | 'directory';
	}) => ({
		message: `Please select a ${engineDisplayName} model ${kind} in settings.`,
		engineDisplayName,
		kind,
	}),
	ModelPathNotFound: ({
		modelPath,
		kind,
	}: {
		modelPath: string;
		kind: 'file' | 'directory';
	}) => ({
		message: `The model ${kind} "${modelPath}" does not exist.`,
		modelPath,
		kind,
	}),
	InvalidModelPath: ({
		engineDisplayName,
		kind,
	}: {
		engineDisplayName: string;
		kind: 'file' | 'directory';
	}) => ({
		message:
			kind === 'directory'
				? `${engineDisplayName} models must be directories containing model files.`
				: `${engineDisplayName} models must be a single file.`,
		engineDisplayName,
		kind,
	}),
	UnexpectedLocalError: ({
		cause,
		engineDisplayName,
	}: {
		cause: unknown;
		engineDisplayName: string;
	}) => ({
		message: extractErrorMessage(cause),
		cause,
		engineDisplayName,
	}),
	ModelLoadError: ({ message }: { message: string }) => ({
		message,
	}),
	GpuError: ({ message }: { message: string }) => ({
		message,
	}),
	AudioReadError: ({ message }: { message: string }) => ({
		message,
	}),
	TranscriptionError: ({ message }: { message: string }) => ({
		message,
	}),
});
export type LocalTranscriptionError = InferErrors<
	typeof LocalTranscriptionError
>;

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
): Promise<Result<void, LocalTranscriptionError>> {
	if (!modelPath) {
		return LocalTranscriptionError.ModelPathRequired({
			engineDisplayName,
			kind,
		});
	}

	const { data: stats } = await tryAsync({
		try: () => stat(modelPath),
		catch: () => Ok(null),
	});

	if (!stats) {
		return LocalTranscriptionError.ModelPathNotFound({
			modelPath,
			kind,
		});
	}

	const isCorrectKind = kind === 'directory' ? stats.isDirectory : stats.isFile;
	if (!isCorrectKind) {
		return LocalTranscriptionError.InvalidModelPath({
			engineDisplayName,
			kind,
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
): Result<never, LocalTranscriptionError> {
	const parsed = LocalTranscriptionErrorType(unknownError);
	if (parsed instanceof type.errors) {
		return LocalTranscriptionError.UnexpectedLocalError({
			cause: unknownError,
			engineDisplayName,
		});
	}

	switch (parsed.name) {
		case 'ModelLoadError':
			return LocalTranscriptionError.ModelLoadError({
				message: parsed.message,
			});

		case 'GpuError':
			return LocalTranscriptionError.GpuError({ message: parsed.message });

		case 'AudioReadError':
			return LocalTranscriptionError.AudioReadError({
				message: parsed.message,
			});

		case 'TranscriptionError':
			return LocalTranscriptionError.TranscriptionError({
				message: parsed.message,
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
): Promise<Result<string, LocalTranscriptionError>> {
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
