/**
 * Path constants for Whispering's appdata directories.
 *
 * Absolute paths under the platform appdata root:
 *   macOS:   ~/Library/Application Support/com.bradenwong.whispering/
 *   Windows: %APPDATA%/com.bradenwong.whispering/
 *   Linux:   ~/.config/com.bradenwong.whispering/
 *
 * Async because `@tauri-apps/api/path` is dynamically imported so the
 * module stays importable from non-Tauri code paths.
 */
export const PATHS = {
	/** Local transcription model directories under `models/`. */
	MODELS: {
		async WHISPER() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			return join(await appDataDir(), 'models', 'whisper');
		},
		async PARAKEET() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			return join(await appDataDir(), 'models', 'parakeet');
		},
		async MOONSHINE() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			return join(await appDataDir(), 'models', 'moonshine');
		},
	},

	/** Filesystem storage for recording audio blobs: `recordings/{id}.{ext}`. */
	DB: {
		/** `recordings/` directory containing audio files. */
		async RECORDINGS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			return join(await appDataDir(), 'recordings');
		},
		/** Path for a newly written recording: `recordings/{id}.{extension}`. */
		async RECORDING_AUDIO(id: string, extension: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			return join(await appDataDir(), 'recordings', `${id}.${extension}`);
		},
		/** Path to an existing recording file given its full filename. */
		async RECORDING_FILE(filename: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			return join(await appDataDir(), 'recordings', filename);
		},
	},
};
