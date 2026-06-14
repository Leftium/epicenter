/**
 * The engine's models folder, as a module. The folder is the single source
 * of truth for local transcription models: catalog downloads land in it,
 * and users add their own models by dropping (or symlinking) them into it.
 * Settings store a folder entry name, never a path; Rust resolves and
 * validates the name against the folder at load time (`model_path_for` in
 * `src-tauri/src/transcription/model_manager.rs`). This module owns the
 * JS view of the folder: listing entries, streaming catalog downloads into
 * it, and deleting entries, never anything outside the folder.
 *
 * UI-free and settings-free. Selection is parent-owned component state:
 * settings bind to a folder entry name, and catalog/custom entries activate
 * through that same `bind:value` path.
 *
 * Layout under the appdata root (see `$lib/services/fs-paths`):
 * - Whisper:   `models/whisper/{filename}` (a single .bin file)
 * - Parakeet:  `models/parakeet/{directoryName}/` (multiple ONNX files)
 * - Moonshine: `models/moonshine/{directoryName}/` (multiple ONNX files)
 */
import { join } from '@tauri-apps/api/path';
import {
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
import {
	type LocalModelConfig,
	modelEntryName,
} from '$lib/constants/local-models';
import { PATHS } from '$lib/services/fs-paths';
import { isModelFileSizeValid } from '$lib/services/transcription/model-file';

export const LocalModelFolderError = defineErrors({
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
});
export type LocalModelFolderError = InferErrors<typeof LocalModelFolderError>;

type Engine = LocalModelConfig['engine'];

/** Extensions a Whisper model file may carry (catalog or user-provided). */
const WHISPER_MODEL_EXTENSIONS = ['.bin', '.gguf', '.ggml'];

/**
 * Resolve a folder entry name to the absolute path Rust loads. Pure path
 * math; does not touch disk. The JS mirror of Rust's `model_path_for`,
 * for JS-side checks that need to stat a known catalog file (e.g. the
 * Whisper truncation check).
 */
export async function resolveModelPath(
	engine: Engine,
	name: string,
): Promise<string> {
	return join(await PATHS.MODELS[engine](), name);
}

export type LocalModelEntry = {
	/** File or directory name inside the engine's models folder. */
	name: string;
	/**
	 * Symlinked entries are listed by link name alone. The webview's fs scope
	 * canonicalizes link targets, so a link pointing outside appdata cannot
	 * be stat'd or read from here; Rust resolves links natively when loading.
	 */
	isSymlink: boolean;
};

/**
 * List every selectable entry in the engine's models folder: model files
 * (.bin, .gguf, .ggml) for Whisper, directories for Parakeet and Moonshine,
 * plus symlinks to either. Hidden entries are skipped. Returns an empty list
 * when the folder does not exist yet. Never rejects.
 */
export async function listModelEntries(
	engine: Engine,
): Promise<LocalModelEntry[]> {
	const { data: entries } = await tryAsync({
		try: async () => {
			const modelsDir = await PATHS.MODELS[engine]();
			if (!(await exists(modelsDir))) return [];
			const dirEntries = await readDir(modelsDir);
			return dirEntries
				.filter((entry) => {
					if (entry.name.startsWith('.')) return false;
					if (engine === 'whispercpp') {
						const hasModelExtension = WHISPER_MODEL_EXTENSIONS.some((ext) =>
							entry.name.endsWith(ext),
						);
						return hasModelExtension && (entry.isFile || entry.isSymlink);
					}
					return entry.isDirectory || entry.isSymlink;
				})
				.map((entry) => ({ name: entry.name, isSymlink: entry.isSymlink }));
		},
		catch: () => Ok([]),
	});
	return (entries ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remove one entry from the engine's models folder. The target is always
 * `join(modelsDir, name)` for a name that `readDir` reported, so this can
 * never delete anything outside the folder, and a symlinked entry removes
 * only the link, never its target. Succeeds when the entry is already gone.
 */
export async function deleteModelEntry({
	engine,
	name,
}: {
	engine: Engine;
	name: string;
}): Promise<Result<void, LocalModelFolderError>> {
	const { data: found, error: readError } = await tryAsync({
		try: async () => {
			const modelsDir = await PATHS.MODELS[engine]();
			if (!(await exists(modelsDir))) return null;
			const entry = (await readDir(modelsDir)).find((e) => e.name === name);
			if (!entry) return null;
			return { entry, path: await join(modelsDir, name) };
		},
		catch: (error) => LocalModelFolderError.DeleteFailed({ cause: error }),
	});
	if (readError) return Err(readError);
	if (!found) return Ok(undefined);

	return tryAsync({
		try: async () => {
			await remove(found.path, { recursive: found.entry.isDirectory });
		},
		catch: (error) =>
			LocalModelFolderError.DeleteFailed({
				// A link pointing outside appdata is scope-rejected even for
				// removal; the user manages that link themselves.
				cause: found.entry.isSymlink
					? 'Whispering cannot remove this link. Delete it from the models folder yourself.'
					: error,
			}),
	});
}

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
}): Promise<Result<void, LocalModelFolderError>> {
	const { data: response, error: fetchError } = await tryAsync({
		try: () => fetch(url),
		catch: (error) => LocalModelFolderError.DownloadFailed({ cause: error }),
	});
	if (fetchError) return Err(fetchError);
	if (!response.ok) {
		return LocalModelFolderError.DownloadRequestFailed({
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
		catch: (error) => LocalModelFolderError.DownloadFailed({ cause: error }),
	});
	if (streamError) return Err(streamError);

	if (downloadedBytes < totalBytes) {
		await tryAsync({
			try: () => remove(filePath),
			catch: () => Ok(undefined),
		});
		return LocalModelFolderError.DownloadIncomplete({
			downloadedMb: Math.round(downloadedBytes / 1_000_000),
			expectedMb: Math.round(totalBytes / 1_000_000),
		});
	}
	return Ok(undefined);
}

/**
 * Per-model handle over a catalog model's install in the folder. Stateless;
 * safe to recreate freely.
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

	async function hasListedSymlinkEntry(): Promise<boolean> {
		const entries = await listModelEntries(model.engine);
		return entries.some(
			(entry) => entry.name === modelEntryName(model) && entry.isSymlink,
		);
	}

	return {
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
					const { data: pathExists } = await tryAsync({
						try: () => exists(path),
						catch: () => Ok(false),
					});
					if (!pathExists) return (await hasListedSymlinkEntry()) ? path : null;

					switch (model.engine) {
						case 'whispercpp': {
							const { data: stats } = await tryAsync({
								try: () => stat(path),
								catch: () => Ok(null),
							});
							if (!stats) {
								return (await hasListedSymlinkEntry()) ? path : null;
							}
							return isModelFileSizeValid(stats.size, model.sizeBytes)
								? path
								: null;
						}
						case 'parakeet':
						case 'moonshine': {
							const { data: dirStats } = await tryAsync({
								try: () => stat(path),
								catch: () => Ok(null),
							});
							if (!dirStats) {
								return (await hasListedSymlinkEntry()) ? path : null;
							}
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
		}): Promise<Result<void, LocalModelFolderError>> {
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
					LocalModelFolderError.DownloadFailed({ cause: error }),
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
								LocalModelFolderError.DownloadFailed({ cause: error }),
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
			return Ok(undefined);
		},

		/**
		 * Remove the model's files from disk. Succeeds even when nothing is
		 * installed, so callers can always reconcile settings afterwards.
		 *
		 * Only ever removes the model's catalog entry name inside its engine's
		 * models folder; nothing outside the folder is reachable.
		 */
		async delete(): Promise<Result<void, LocalModelFolderError>> {
			return deleteModelEntry({
				engine: model.engine,
				name: modelEntryName(model),
			});
		},
	};
}
