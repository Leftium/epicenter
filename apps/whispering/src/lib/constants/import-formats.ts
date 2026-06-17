/**
 * File extensions the import surface accepts.
 *
 * Import is its own surface, not a recording trigger (see ADR-0010), so these
 * live apart from the recording constants. The Tauri drag-and-drop handler
 * filters dropped paths by extension against these lists; the web file picker
 * filters by MIME through `@epicenter/ui`'s `ACCEPT_AUDIO` / `ACCEPT_VIDEO`
 * instead.
 */
export const IMPORTABLE_AUDIO_EXTENSIONS = [
	'mp3',
	'wav',
	'm4a',
	'aac',
	'ogg',
	'flac',
	'wma',
	'opus',
] as const;

export const IMPORTABLE_VIDEO_EXTENSIONS = [
	'mp4',
	'avi',
	'mov',
	'wmv',
	'flv',
	'mkv',
	'webm',
	'm4v',
] as const;
