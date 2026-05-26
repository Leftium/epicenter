/**
 * Web stub. The real implementation lives in `index.tauri.ts`. This file
 * exists so static imports from web-bundled consumers (notably the
 * `rpc/desktop/` adapters) resolve at `vite build` time. Anything called
 * here throws clearly; web consumers gate on `window.__TAURI_INTERNALS__`
 * so the throws are unreachable at runtime.
 *
 * Platform-neutral helpers (constants, file-extension function) live in
 * `./shared` and are re-exported here so consumers don't need a second
 * import path.
 */

function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}

export {
	FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
	FFMPEG_SMALLEST_COMPRESSION_OPTIONS,
	getFileExtensionFromFfmpegOptions,
} from './shared';

export const FfmpegError = {
	InstallCheckFailed: unreachable,
	VerifyFailed: unreachable,
	CompressFailed: unreachable,
} as unknown as typeof import('./index.tauri').FfmpegError;

export const FfmpegServiceLive = {
	checkInstalled: unreachable,
	compressAudioBlob: unreachable,
} as unknown as typeof import('./index.tauri').FfmpegServiceLive;
