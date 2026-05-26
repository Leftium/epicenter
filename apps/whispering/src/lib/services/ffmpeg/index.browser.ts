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

import { unreachable } from '$lib/services/_tauri-stub';
import type * as Tauri from './index.tauri';

export {
	FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
	FFMPEG_SMALLEST_COMPRESSION_OPTIONS,
	getFileExtensionFromFfmpegOptions,
} from './shared';

export const FfmpegError = {
	InstallCheckFailed: unreachable,
	VerifyFailed: unreachable,
	CompressFailed: unreachable,
} satisfies typeof Tauri.FfmpegError;

export const FfmpegServiceLive = {
	checkInstalled: unreachable,
	compressAudioBlob: unreachable,
} satisfies typeof Tauri.FfmpegServiceLive;
