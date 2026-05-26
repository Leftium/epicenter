function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}
const stub: any = new Proxy(() => unreachable(), { get: () => unreachable });
export const FFMPEG_DEFAULT_COMPRESSION_OPTIONS = '';
export const FFMPEG_SMALLEST_COMPRESSION_OPTIONS = '';
export const getFileExtensionFromFfmpegOptions = stub as (
	outputOptions: string,
) => string;
export const FfmpegError = stub;
export const FfmpegServiceLive = stub;
