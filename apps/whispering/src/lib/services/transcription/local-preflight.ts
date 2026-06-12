import { readDir, stat } from '@tauri-apps/plugin-fs';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

/**
 * FE-side validation that a model path satisfies an engine's contract. Two
 * gates share it: the settings selector when the user picks a model, and the
 * dispatcher in `$lib/operations/transcribe.ts` before every local
 * transcription (so a model moved or deleted after selection degrades into a
 * clear error instead of a Rust failure).
 *
 * After the Rust call, Rust's own `TranscriptionError` variants
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
	EmptyModelDirectory: () => ({
		message: 'Selected directory appears to be empty',
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
});
export type LocalPreflightError = InferErrors<typeof LocalPreflightError>;

/**
 * Validate that `modelPath` exists, is the expected `kind`, and (for
 * directories) is not empty. All local engines share this exact check, both
 * at selection time and before transcription.
 */
export async function requireValidModelPath(
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

	if (kind === 'directory') {
		const { data: entries } = await tryAsync({
			try: () => readDir(modelPath),
			catch: () => Ok(null),
		});
		if (!entries) {
			return LocalPreflightError.InvalidModelPath({ engineDisplayName, kind });
		}
		if (entries.length === 0) {
			return LocalPreflightError.EmptyModelDirectory();
		}
	}

	return Ok(undefined);
}
