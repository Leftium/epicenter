/**
 * Web stub. `operations/transcribe.ts` statically imports
 * `FfmpegServiceLive` from this path (it conditionally compresses audio
 * before transcription, only on Tauri). Web needs the path to resolve;
 * the call site is gated so the throws are unreachable.
 *
 * Platform-neutral helpers live in `./shared` and are re-exported here
 * for backwards compatibility with consumers that import them via
 * `$lib/services/ffmpeg` instead of `$lib/services/ffmpeg/shared`.
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
