import type { RecordingOverlayStatus } from '$lib/recording-overlay/events';

/**
 * Browser build of the recording overlay seam.
 *
 * The floating overlay is a native always-on-top window, which only exists in
 * the Tauri build. On web there is nothing to show, so `sync` is a no-op. The
 * shape matches the Tauri implementation so shared callers stay platform
 * agnostic.
 */
export const recordingOverlay = {
	sync(_status: RecordingOverlayStatus | null): void {},
	reportLevel(_level: number): void {},
};
