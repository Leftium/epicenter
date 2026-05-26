/**
 * Platform-neutral FFmpeg helpers. Importable from web because none of
 * these touch Tauri APIs; they're just strings and pure functions.
 *
 * The actual FFmpeg service (`FfmpegServiceLive`) is Tauri-only and
 * lives in `index.tauri.ts` alongside this file.
 */

/**
 * Default FFmpeg compression options optimized for transcription.
 * Speech-tuned Opus at 32kbps mono 16kHz with silence trimming.
 */
export const FFMPEG_DEFAULT_COMPRESSION_OPTIONS =
	'-af silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:detection=peak,aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono -c:a libopus -b:a 32k -ar 16000 -ac 1 -compression_level 10' as const;

/**
 * Variant prioritizing smallest file size: Opus at 16kbps.
 */
export const FFMPEG_SMALLEST_COMPRESSION_OPTIONS =
	FFMPEG_DEFAULT_COMPRESSION_OPTIONS.replace('-b:a 32k', '-b:a 16k');

/**
 * Maps FFmpeg output options to a sensible file extension for the produced blob.
 */
export function getFileExtensionFromFfmpegOptions(outputOptions: string) {
	if (outputOptions.includes('libopus')) return 'opus';
	if (outputOptions.includes('libmp3lame')) return 'mp3';
	if (outputOptions.includes('libvorbis')) return 'ogg';
	if (outputOptions.includes('aac')) return 'm4a';
	if (outputOptions.includes('pcm_')) return 'wav';
	return 'wav';
}
