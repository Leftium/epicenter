import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { log, report } from '$lib/report';
import { settings } from '$lib/state/settings.svelte';
import type { MediaControlFailure, MediaPlayer } from '$lib/tauri/commands';

type RecordingMediaSession = {
	id: number;
	paused: Promise<MediaPlayer[]>;
	resumed: boolean;
};

let activeSession: RecordingMediaSession | null = null;
let nextSessionId = 0;
let didExplainPermissionDenied = false;

function shouldPauseMedia(): boolean {
	return Boolean(
		tauri && os.isApple && settings.get('sound.pauseMediaDuringRecording'),
	);
}

function logFailures(
	action: 'pause' | 'resume',
	failures: MediaControlFailure[],
) {
	for (const failure of failures) {
		log.warn(
			new Error(`Failed to ${action} ${failure.player}: ${failure.message}`),
			failure,
		);
	}

	if (
		failures.some((failure) => failure.permissionDenied) &&
		!didExplainPermissionDenied
	) {
		didExplainPermissionDenied = true;
		report.info({
			title: 'Media control is blocked',
			description:
				'Allow Whispering to control Music or Spotify in macOS Automation settings.',
		});
	}
}

async function pauseActiveMedia(): Promise<MediaPlayer[]> {
	if (!tauri) return [];

	try {
		const { data, error } = await tauri.media.pauseActive();
		if (error !== null) {
			log.warn(new Error(`Failed to pause active media: ${error}`));
			return [];
		}

		logFailures('pause', data.failures);
		return data.paused;
	} catch (error) {
		log.warn(new Error(`Failed to pause active media: ${String(error)}`));
		return [];
	}
}

export const recordingMedia = {
	startSession(): RecordingMediaSession | null {
		if (!shouldPauseMedia()) return null;
		if (activeSession) return activeSession;

		const session = {
			id: ++nextSessionId,
			paused: pauseActiveMedia(),
			resumed: false,
		};
		activeSession = session;
		return session;
	},

	async waitForPause(session: RecordingMediaSession | null): Promise<void> {
		await session?.paused;
	},

	async resumeSession(session: RecordingMediaSession | null): Promise<void> {
		if (!session || session.resumed) return;

		session.resumed = true;

		const paused = await session.paused;
		if (paused.length > 0) {
			if (tauri) {
				try {
					const { data, error } = await tauri.media.resume(paused);
					if (error !== null) {
						log.warn(new Error(`Failed to resume media: ${error}`));
					} else {
						logFailures('resume', data);
					}
				} catch (error) {
					log.warn(new Error(`Failed to resume media: ${String(error)}`));
				}
			}
		}

		if (activeSession?.id === session.id) {
			activeSession = null;
		}
	},

	resumeActiveSession(): Promise<void> {
		return this.resumeSession(activeSession);
	},
};
