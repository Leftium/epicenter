/**
 * On-disk storage for pre-built local transcription models: resolve where a
 * model lives, verify an install, stream downloads from the catalog URLs,
 * import user-selected files or directories, and delete installs.
 *
 * UI-free and settings-free. Activation (writing the model path into
 * `deviceConfig`) lives in `$lib/operations/local-models.ts`.
 *
 * Layout under the appdata root (see `$lib/services/fs-paths`):
 * - Whisper:   `models/whisper/{filename}` (a single .bin file)
 * - Parakeet:  `models/parakeet/{directoryName}/` (multiple ONNX files)
 * - Moonshine: `models/moonshine/{directoryName}/` (multiple ONNX files)
 */
import { basename, join } from '@tauri-apps/api/path';
import {
	copyFile,
	exists,
	mkdir,
	readDir,
	remove,
	stat,
	writeFile,
} from '@tauri-apps/plugin-fs';
import { fetch } from '@tauri-apps/plugin-http';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { LocalModelConfig } from '$lib/constants/local-models';
import { PATHS } from '$lib/services/fs-paths';
import { isModelFileSizeValid } from '$lib/services/transcription/model-file';

export const LocalModelStorageError = defineErrors({
	DownloadRequestFailed: ({
		url,
		status,
	}: {
		url: string;
		status: number;
	}) => ({
		message: `Failed to download: ${status}`,
		url,
		status,
	}),
	DownloadIncomplete: ({
		downloadedMb,
		expectedMb,
	}: {
		downloadedMb: number;
		expectedMb: number;
	}) => ({
		message: `Download incomplete: received ${downloadedMb}MB but expected ${expectedMb}MB. Please check your network connection and try again.`,
		downloadedMb,
		expectedMb,
	}),
	DownloadFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	DeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	ImportFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	EmptyModelDirectory: () => ({
		message: 'Selected directory appears to be empty',
	}),
});
export type LocalModelStorageError = InferErrors<typeof LocalModelStorageError>;

type Engine = LocalModelConfig['engine'];

/**
 * Stream one file to disk, appending chunk by chunk so large models never
 * buffer fully in memory. Reports whole-file progress as 0-100.
 */
async function downloadFileTo({
	url,
	sizeBytes,
	filePath,
	onProgress,
}: {
	url: string;
	/** Catalog size, used when the response has no content-length header. */
	sizeBytes: number;
	filePath: string;
	onProgress: (progress: number) => void;
}): Promise<Result<void, LocalModelStorageError>> {
	const { data: response, error: fetchError } = await tryAsync({
		try: () => fetch(url),
		catch: (error) => LocalModelStorageError.DownloadFailed({ cause: error }),
	});
	if (fetchError) return Err(fetchError);
	if (!response.ok) {
		return LocalModelStorageError.DownloadRequestFailed({
			url,
			status: response.status,
		});
	}

	const contentLength = response.headers.get('content-length');
	const totalBytes = contentLength
		? Number.parseInt(contentLength, 10)
		: sizeBytes;

	const { data: downloadedBytes, error: streamError } = await tryAsync({
		try: async () => {
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('Failed to read response body');
			}

			// Create or truncate the file first
			await writeFile(filePath, new Uint8Array());

			let bytes = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// Write each chunk directly to disk using append mode
				await writeFile(filePath, value, { append: true });

				bytes += value.length;
				onProgress(Math.round((bytes / totalBytes) * 100));
			}
			return bytes;
		},
		catch: (error) => LocalModelStorageError.DownloadFailed({ cause: error }),
	});
	if (streamError) return Err(streamError);

	if (downloadedBytes < totalBytes) {
		await tryAsync({
			try: () => remove(filePath),
			catch: () => Ok(undefined),
		});
		return LocalModelStorageError.DownloadIncomplete({
			downloadedMb: Math.round(downloadedBytes / 1_000_000),
			expectedMb: Math.round(totalBytes / 1_000_000),
		});
	}
	return Ok(undefined);
}

/**
 * Per-model handle over the model's on-disk install. Stateless; safe to
 * recreate freely.
 */
export function createModelStorage(model: LocalModelConfig) {
	async function getPath(): Promise<string> {
		const dir = await PATHS.MODELS[model.engine]();
		switch (model.engine) {
			case 'whispercpp':
				return join(dir, model.file.filename);
			case 'parakeet':
			case 'moonshine':
				return join(dir, model.directoryName);
		}
	}

	return {
		/**
		 * The canonical install path: a file for Whisper, a directory for
		 * Parakeet and Moonshine. Pure path math; does not touch disk.
		 */
		getPath,

		/**
		 * The canonical path when a valid install exists there, else null.
		 * Every expected file must exist with a plausible size (at least 90%
		 * of the catalog size), so interrupted downloads read as missing.
		 * Never rejects; any filesystem or path error reads as missing.
		 */
		async getInstalledPath(): Promise<string | null> {
			const { data: installedPath } = await tryAsync({
				try: async (): Promise<string | null> => {
					const path = await getPath();
					if (!(await exists(path))) return null;
					switch (model.engine) {
						case 'whispercpp': {
							const stats = await stat(path);
							return isModelFileSizeValid(stats.size, model.sizeBytes)
								? path
								: null;
						}
						case 'parakeet':
						case 'moonshine': {
							const dirStats = await stat(path);
							if (!dirStats.isDirectory) return null;
							for (const file of model.files) {
								const filePath = await join(path, file.filename);
								if (!(await exists(filePath))) return null;
								const fileStats = await stat(filePath);
								if (!isModelFileSizeValid(fileStats.size, file.sizeBytes)) {
									return null;
								}
							}
							return path;
						}
					}
				},
				catch: () => Ok(null),
			});
			return installedPath ?? null;
		},

		/**
		 * Download the model to its canonical path. `onProgress` receives
		 * overall progress as 0-100, aggregated across files for multi-file
		 * models. Does not check for an existing install; callers decide
		 * whether to skip.
		 */
		async download({
			onProgress,
		}: {
			onProgress: (progress: number) => void;
		}): Promise<Result<{ path: string }, LocalModelStorageError>> {
			const { data: path, error: prepareError } = await tryAsync({
				try: async () => {
					await mkdir(await PATHS.MODELS[model.engine](), { recursive: true });
					const destination = await getPath();
					if (model.engine !== 'whispercpp') {
						await mkdir(destination, { recursive: true });
					}
					return destination;
				},
				catch: (error) =>
					LocalModelStorageError.DownloadFailed({ cause: error }),
			});
			if (prepareError) return Err(prepareError);

			switch (model.engine) {
				case 'whispercpp': {
					const { error } = await downloadFileTo({
						url: model.file.url,
						sizeBytes: model.sizeBytes,
						filePath: path,
						onProgress,
					});
					if (error) return Err(error);
					break;
				}
				case 'parakeet':
				case 'moonshine': {
					const totalBytes = model.sizeBytes;
					let completedBytes = 0;
					for (const file of model.files) {
						const { data: filePath, error: joinError } = await tryAsync({
							try: () => join(path, file.filename),
							catch: (error) =>
								LocalModelStorageError.DownloadFailed({ cause: error }),
						});
						if (joinError) return Err(joinError);
						const { error } = await downloadFileTo({
							url: file.url,
							sizeBytes: file.sizeBytes,
							filePath,
							onProgress: (fileProgress) => {
								onProgress(
									Math.round(
										((completedBytes + (file.sizeBytes * fileProgress) / 100) /
											totalBytes) *
											100,
									),
								);
							},
						});
						if (error) return Err(error);
						completedBytes += file.sizeBytes;
					}
					break;
				}
			}
			return Ok({ path });
		},

		/**
		 * Remove the model's files from disk. Succeeds (and returns the
		 * canonical path) even when nothing is installed, so callers can
		 * always reconcile settings against the returned path.
		 */
		async delete(): Promise<Result<{ path: string }, LocalModelStorageError>> {
			return tryAsync({
				try: async () => {
					const path = await getPath();
					if (await exists(path)) {
						const isDirectory = model.engine !== 'whispercpp';
						await remove(path, { recursive: isDirectory });
					}
					return { path };
				},
				catch: (error) => LocalModelStorageError.DeleteFailed({ cause: error }),
			});
		},
	};
}

/** Copy a user-selected model file into the engine's models directory. */
export async function importModelFile({
	engine,
	sourcePath,
}: {
	engine: Engine;
	sourcePath: string;
}): Promise<Result<{ path: string }, LocalModelStorageError>> {
	return tryAsync({
		try: async () => {
			const modelsDir = await PATHS.MODELS[engine]();
			await mkdir(modelsDir, { recursive: true });
			const destination = await join(modelsDir, await basename(sourcePath));
			await copyFile(sourcePath, destination);
			return { path: destination };
		},
		catch: (error) => LocalModelStorageError.ImportFailed({ cause: error }),
	});
}

async function copyDirectoryRecursive(
	sourceDir: string,
	destinationDir: string,
): Promise<void> {
	await mkdir(destinationDir, { recursive: true });
	const entries = await readDir(sourceDir);

	for (const entry of entries) {
		const sourcePath = await join(sourceDir, entry.name);
		const destinationPath = await join(destinationDir, entry.name);

		if (entry.isDirectory) {
			await copyDirectoryRecursive(sourcePath, destinationPath);
		} else if (entry.isFile) {
			await copyFile(sourcePath, destinationPath);
		} else {
			throw new Error('Selected model directory cannot include symlinks');
		}
	}
}

/**
 * Copy a user-selected model directory into the engine's models directory,
 * keeping the source directory's name. Rejects empty directories and
 * directories containing symlinks.
 */
export async function importModelDirectory({
	engine,
	sourceDir,
}: {
	engine: Engine;
	sourceDir: string;
}): Promise<Result<{ path: string }, LocalModelStorageError>> {
	const { data: entries, error: readError } = await tryAsync({
		try: () => readDir(sourceDir),
		catch: (error) => LocalModelStorageError.ImportFailed({ cause: error }),
	});
	if (readError) return Err(readError);
	if (entries.length === 0) {
		return LocalModelStorageError.EmptyModelDirectory();
	}

	return tryAsync({
		try: async () => {
			const modelsDir = await PATHS.MODELS[engine]();
			await mkdir(modelsDir, { recursive: true });
			const destination = await join(modelsDir, await basename(sourceDir));
			await copyDirectoryRecursive(sourceDir, destination);
			return { path: destination };
		},
		catch: (error) => LocalModelStorageError.ImportFailed({ cause: error }),
	});
}
