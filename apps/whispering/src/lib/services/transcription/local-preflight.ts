import { stat } from '@tauri-apps/plugin-fs';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

/**
 * Errors raised by the FE before we hand off to the Rust `transcribe_recording`
 * command. After the call returns, Rust's own `TranscriptionError` variants
 * (ModelLoadError, GpuError, AudioReadError, TranscriptionError) flow through
 * to the caller unchanged: see `$lib/tauri/commands`. They satisfy
 * `AnyTaggedError`, so the caller's `Result<string, TranscriptionError>`
 * return type covers them without a translation layer.
 */
export const LocalPreflightError = defineErrors({
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
	InvalidMoonshineDirectoryName: () => ({
		message:
			'Model path must end with moonshine-{variant}-{lang} (e.g., "moonshine-tiny-en", "moonshine-base-en")',
	}),
});
export type LocalPreflightError = InferErrors<typeof LocalPreflightError>;

/**
 * Validate that `modelPath` exists and is the expected `kind`. All local
 * engines share this exact preflight.
 */
export async function requireExistingModelPath(
	modelPath: string,
	kind: 'file' | 'directory',
	engineDisplayName: string,
): Promise<Result<void, LocalPreflightError>> {
	if (!modelPath) {
		return LocalPreflightError.ModelPathRequired({ engineDisplayName, kind });
	}

	const { data: stats } = await tryAsync({
		try: () => stat(modelPath),
		catch: () => Ok(null),
	});

	if (!stats) {
		return LocalPreflightError.ModelPathNotFound({ modelPath, kind });
	}

	const isCorrectKind = kind === 'directory' ? stats.isDirectory : stats.isFile;
	if (!isCorrectKind) {
		return LocalPreflightError.InvalidModelPath({ engineDisplayName, kind });
	}

	return Ok(undefined);
}
