import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { log, report } from '$lib/report';
import { settings } from '$lib/state/settings.svelte';
import type { MediaControlFailure, MediaPlayer } from '$lib/tauri/commands';

// The one best-effort macOS side effect for recording: pause Music/Spotify
// while recording, resume them after. Recording never waits on this and never
// fails because of it. `pause()` fires without awaiting; `resume()` waits for
// that pause to settle, then restores exactly the players it paused.
//
// The pending pause promise is the entire state: it answers the only question
// resume needs ("which players did I pause?") and doubles as the "currently
// paused" flag.

let pausedPromise: Promise<MediaPlayer[]> | null = null;
let didExplainPermissionDenied = false;

function shouldPauseMedia(): boolean {
	return Boolean(
		tauri && os.isApple && settings.get('sound.pauseMediaDuringRecording'),
	);
}

/** Log every failure, and surface the permission hint once per session. */
function reportFailures(failures: MediaControlFailure[]): void {
	for (const failure of failures) {
		log.warn(
			new Error(
				`Media control failed for ${failure.player}: ${failure.message}`,
			),
			failure,
		);
	}

	if (didExplainPermissionDenied) return;
	if (!failures.some((failure) => failure.permissionDenied)) return;

	didExplainPermissionDenied = true;
	report.info({
		title: 'Media control is blocked',
		description:
			'Allow Whispering to control Music or Spotify in macOS Automation settings.',
	});
}

async function pauseActiveMedia(): Promise<MediaPlayer[]> {
	if (!tauri) return [];
	try {
		const { data, error } = await tauri.media.pause();
		if (error !== null) {
			log.warn(new Error(`Failed to pause media: ${error}`));
			return [];
		}
		reportFailures(data.failures);
		return data.paused;
	} catch (error) {
		log.warn(new Error(`Failed to pause media: ${String(error)}`));
		return [];
	}
}

export const recordingMedia = {
	/** Pause active media if enabled. Fire-and-forget: recording never waits. */
	pause(): void {
		if (pausedPromise || !shouldPauseMedia()) return;
		pausedPromise = pauseActiveMedia();
	},

	/**
	 * Resume whatever the matching `pause()` paused. A no-op when nothing was
	 * paused, so every stop/cancel/start-failure path can call it blindly.
	 */
	async resume(): Promise<void> {
		const pending = pausedPromise;
		if (!pending) return;
		pausedPromise = null;

		const paused = await pending;
		if (!tauri || paused.length === 0) return;

		try {
			const { data, error } = await tauri.media.resume(paused);
			if (error !== null) {
				log.warn(new Error(`Failed to resume media: ${error}`));
				return;
			}
			reportFailures(data);
		} catch (error) {
			log.warn(new Error(`Failed to resume media: ${String(error)}`));
		}
	},
};
