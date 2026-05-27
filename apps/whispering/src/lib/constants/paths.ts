/**
 * Centralized path constants for the Whispering desktop app.
 *
 * All paths are absolute and resolve relative to the platform-specific app data directory:
 * - macOS: `~/Library/Application Support/com.bradenwong.whispering/`
 * - Windows: `%APPDATA%/com.bradenwong.whispering/`
 * - Linux: `~/.config/com.bradenwong.whispering/`
 *
 * Methods are async because they use Tauri's path APIs which require dynamic imports.
 */
export const PATHS = {
	/**
	 * Paths to local ML model directories.
	 *
	 * Each model type has its own subdirectory under `models/` where downloaded
	 * model files are stored for local transcription.
	 */
	MODELS: {
		/** Directory for Whisper C++ model files (e.g., ggml-base.bin, ggml-large-v3.bin) */
		async WHISPER() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return join(dir, 'models', 'whisper');
		},
		/** Directory for Parakeet model files */
		async PARAKEET() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return join(dir, 'models', 'parakeet');
		},
		/** Directory for Moonshine model files */
		async MOONSHINE() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return join(dir, 'models', 'moonshine');
		},
	},

	/**
	 * Paths for the file-system database (desktop only).
	 *
	 * The desktop app stores recording audio blobs in appdata. Recording rows
	 * live in the workspace database; markdown export is a separate,
	 * user-selected folder.
	 *
	 * Transformation helpers still point at appdata markdown directories:
	 *
	 * ```
	 * recordings/
	 *   {id}.webm    <- audio file (extension varies: .webm, .mp3, .wav, etc.)
	 * transformations/
	 *   {id}.md      <- transformation configuration
	 * transformation-runs/
	 *   {id}.md      <- execution history for a transformation
	 * ```
	 *
	 * ## Helper Types
	 *
	 * **Directory helpers** (`RECORDINGS`, `TRANSFORMATIONS`, `TRANSFORMATION_RUNS`):
	 * Return the base directory path. Use these when you need to list files,
	 * check if the directory exists, or pass to Rust commands that operate on
	 * directories.
	 *
	 * **Typed file helpers** (`RECORDING_AUDIO`, `TRANSFORMATION_MD`, `TRANSFORMATION_RUN_MD`):
	 * Return the absolute path to a specific file type given an ID. Use these when you
	 * know exactly what file you're targeting (reading, writing, or deleting a specific record).
	 *
	 * **Generic file helper** (`RECORDING_FILE`):
	 * Returns the absolute path given any filename. Use this when iterating over directory
	 * contents where you have the full filename but not the parsed ID/extension.
	 */
	DB: {
		/*
		 * ============================================================================
		 * RECORDINGS
		 * ============================================================================
		 * The recordings appdata directory stores audio blobs only:
		 * - {id}.{ext}: Audio file (extension depends on recording format: webm, mp3, wav, etc.)
		 */

		/**
		 * Base directory containing recording audio files.
		 *
		 * Use this when you need to:
		 * - List all files in the recordings directory
		 * - Check if the recordings directory exists
		 * - Pass to filesystem helpers in `services/blob-store`
		 *
		 * @returns Absolute path to the recordings directory
		 *
		 * @example
		 * ```typescript
		 * const recordingsPath = await PATHS.DB.RECORDINGS();
		 * const files = await readDir(recordingsPath);
		 * ```
		 */
		async RECORDINGS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return join(dir, 'recordings');
		},

		/**
		 * Path to a recording's audio file with a specific extension.
		 *
		 * Use this when **creating** a new recording where you know the audio format.
		 * The extension is determined by the MIME type of the recorded audio blob.
		 *
		 * @param id - The recording's unique identifier
		 * @param extension - The audio file extension without the dot (e.g., 'webm', 'mp3', 'wav')
		 * @returns Absolute path to `recordings/{id}.{extension}`
		 *
		 * @example
		 * ```typescript
		 * const extension = mime.getExtension(audioBlob.type) ?? 'bin';
		 * const audioPath = await PATHS.DB.RECORDING_AUDIO('abc123', extension);
		 * await writeFile(audioPath, new Uint8Array(await audioBlob.arrayBuffer()));
		 * ```
		 */
		async RECORDING_AUDIO(id: string, extension: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return join(dir, 'recordings', `${id}.${extension}`);
		},

		/**
		 * Path to any file in the recordings directory given its full filename.
		 *
		 * Use this when you have the complete filename (e.g., from `readDir`) and need
		 * the absolute path for an audio blob whose extension was discovered at runtime.
		 *
		 * Common use cases:
		 * - Iterating over directory contents to build paths for bulk operations
		 * - Looking up audio files where the extension is unknown (scan directory, find match)
		 * - Deleting files when you only have the filename from a directory listing
		 *
		 * @param filename - The complete audio filename including extension (e.g., 'abc123.webm')
		 * @returns Absolute path to `recordings/{filename}`
		 *
		 * @example
		 * ```typescript
		 * // Bulk delete: iterate directory and build absolute paths
		 * const files = await readDir(recordingsPath);
		 * const pathsToDelete = await Promise.all(
		 *   files.filter(f => idsToDelete.has(f.name.split('.')[0]))
		 *        .map(f => PATHS.DB.RECORDING_FILE(f.name))
		 * );
		 * await bulkDeleteFiles(pathsToDelete);
		 *
		 * // Find audio file when extension is unknown
		 * const audioFile = files.find(f => f.name.startsWith(`${id}.`) && !f.name.endsWith('.md'));
		 * const audioPath = await PATHS.DB.RECORDING_FILE(audioFile.name);
		 * ```
		 */
		async RECORDING_FILE(filename: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return join(dir, 'recordings', filename);
		},
	},
};
