import { stat } from '@tauri-apps/plugin-fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	commands,
	type TranscribeRequest,
	type TranscriptionError,
} from '$lib/tauri/commands';

/**
 * The Rust `TranscribeRequest` enum (`#[serde(tag = "engine", rename_all =
 * "lowercase")]`) is the single source of truth for this argument shape;
 * the boundary file re-exports the generated TS union. We keep the local
 * alias `TranscribeConfig` so engine adapters that already import it stay
 * unchanged.
 */
export type TranscribeConfig = TranscribeRequest;

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
	UnexpectedLocalError: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type LocalTranscriptionError = InferErrors<
	typeof LocalTranscriptionError
>;

/**
 * Validate that `modelPath` exists and is the expected `kind`. All three
 * local services share this exact preflight.
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

function mapLocalTranscriptionError(
	error: TranscriptionError,
): Result<never, LocalTranscriptionError> {
	switch (error.name) {
		case 'ModelLoadError':
			return LocalTranscriptionError.ModelLoadError({
				message: error.message,
			});
		case 'GpuError':
			return LocalTranscriptionError.GpuError({ message: error.message });
		case 'AudioReadError':
			return LocalTranscriptionError.AudioReadError({
				message: error.message,
			});
		case 'TranscriptionError':
			return LocalTranscriptionError.TranscriptionError({
				message: error.message,
			});
		default:
			return LocalTranscriptionError.UnexpectedLocalError({ cause: error });
	}
}

/**
 * Canonical transcribe-by-id path. Rust resolves the recording file under
 * `<appDataDir>/recordings/{recordingId}.*`, decodes it, and runs inference.
 */
export async function transcribeRecording(
	recordingId: string,
	config: TranscribeConfig,
): Promise<Result<string, LocalTranscriptionError>> {
	const { data, error } = await commands.transcribeRecording(
		recordingId,
		config,
	);
	if (error !== null) return mapLocalTranscriptionError(error);
	return Ok(data);
}
