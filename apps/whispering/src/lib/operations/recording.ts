import { nanoid } from 'nanoid/non-secure';
import { manualRecorderConfig } from '#platform/manual-recorder-config';
import { recordingOverlay } from '#platform/recording-overlay';
import { goto } from '$app/navigation';
import type { ShortcutEventState } from '$lib/commands';
import { analytics } from '$lib/operations/analytics';
import { recordingMedia } from '$lib/operations/media';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { sound } from '$lib/operations/sound';
import { log, type Notice, report } from '$lib/report';
import type { DeviceAcquisitionOutcome } from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

function handleDeviceAcquisitionOutcome(
	outcome: DeviceAcquisitionOutcome,
	successTitle: string,
	successDescription: string,
	persist: (deviceId: string) => void,
): Notice {
	if (outcome.outcome === 'success') {
		return {
			title: successTitle,
			description: successDescription,
		};
	}

	persist(outcome.deviceId);
	switch (outcome.reason) {
		case 'no-device-selected':
			return {
				title: '🎙️ Switched to available microphone',
				description:
					'No microphone was selected, so we automatically connected to an available one. You can update your selection in settings.',
				action: {
					label: 'Open Settings',
					onClick: () => goto('/settings/recording'),
				},
			};
		case 'preferred-device-unavailable':
			return {
				title: '🎙️ Switched to different microphone',
				description:
					"Your previously selected microphone wasn't found, so we automatically connected to an available one.",
				action: {
					label: 'Open Settings',
					onClick: () => goto('/settings/recording'),
				},
			};
	}
}

function isVadRecordingActive() {
	return (
		vadRecorder.state === 'LISTENING' || vadRecorder.state === 'SPEECH_DETECTED'
	);
}

export async function startManualRecording() {
	settings.set('recording.mode', 'manual');

	const loading = report.loading({
		title: '🎙️ Preparing to record...',
		description: 'Setting up your recording environment...',
	});

	recordingMedia.pause();

	const { data: outcome, error } = await manualRecorder.startRecording();

	if (error) {
		void recordingMedia.resume();
		loading.reject({ cause: error });
		return;
	}

	loading.resolve(
		handleDeviceAcquisitionOutcome(
			outcome,
			'🎙️ Whispering is recording...',
			'Speak now and stop recording when done',
			(deviceId) => {
				manualRecorderConfig.deviceId = deviceId;
			},
		),
	);

	log.info('Recording started');
	sound.playSoundIfEnabled('manual-start');
}

export async function stopManualRecording() {
	const loading = report.loading({
		title: '⏸️ Stopping recording...',
		description: 'Finalizing your audio capture...',
	});

	const { data: source, error } = await manualRecorder.stopRecording();

	if (error) {
		void recordingMedia.resume();
		loading.reject({ cause: error });
		return;
	}

	const durationMs =
		source.kind === 'artifact' ? source.artifact.durationMs : source.durationMs;
	const byteLength =
		source.kind === 'artifact' ? source.artifact.byteLength : source.blob.size;

	loading.resolve({
		title: '🎙️ Recording stopped',
		description: 'Your recording has been saved',
	});
	log.info('Recording stopped');
	sound.playSoundIfEnabled('manual-stop');
	void recordingMedia.resume();

	analytics.logEvent({
		type: 'manual_recording_completed',
		blob_size: byteLength,
		duration: durationMs ?? undefined,
	});

	await processRecordingPipeline({
		source,
		durationMs,
	});
}

export function toggleManualRecording() {
	if (manualRecorder.state === 'RECORDING') {
		return stopManualRecording();
	}
	return startManualRecording();
}

// ── Recording shortcut: one key, tap to toggle or hold to talk ────────────────
//
// The recording shortcut is a single binding (default Fn on macOS) that serves
// both interaction models off the press/release edges, with NO start latency:
// recording always begins on the press. Only the STOP decision is deferred to
// the release, where the hold duration classifies what the user meant:
//
//   hold (>= HOLD_THRESHOLD_MS): stop on release    (push-to-talk)
//   tap  (<  HOLD_THRESHOLD_MS): keep recording      (toggle on; next tap stops)
//
// A click on an in-app record button calls the command with no edge
// (`undefined`), which is the plain toggle; press/release edges only ever arrive
// from a keyboard backend.

const HOLD_THRESHOLD_MS = 300;

type ManualShortcutPhase = 'idle' | 'capturing' | 'latched';
let manualShortcutPhase: ManualShortcutPhase = 'idle';
let manualPressedAt = 0;

export function manualRecordingShortcut(state?: ShortcutEventState) {
	// A click (no press/release edge) is a plain toggle, never push-to-talk.
	if (state === undefined) {
		void toggleManualRecording();
		return;
	}

	if (state === 'Pressed') {
		// A press while latched is the second tap: it stops the toggled session.
		if (manualShortcutPhase === 'latched') {
			manualShortcutPhase = 'idle';
			void stopManualRecording();
			return;
		}
		// Otherwise begin capture immediately, before we know tap from hold.
		manualShortcutPhase = 'capturing';
		manualPressedAt = performance.now();
		void startManualRecording();
		return;
	}

	// state === 'Released'. Only meaningful while a press is being classified; the
	// release that ends a stopping tap lands in `idle` and is correctly ignored.
	if (manualShortcutPhase !== 'capturing') return;
	const heldMs = performance.now() - manualPressedAt;
	if (heldMs >= HOLD_THRESHOLD_MS) {
		// Held long enough to read as push-to-talk: stop now, on release. Stop
		// unconditionally and do NOT gate on `manualRecorder.state`: that flips to
		// RECORDING only after start's async device acquisition resolves, so a hold
		// released before that lag clears would read as not-recording and the
		// session would never stop. We started the capture, so we own the stop.
		manualShortcutPhase = 'idle';
		void stopManualRecording();
	} else {
		// A quick tap: leave recording running and wait for the next tap to stop.
		manualShortcutPhase = 'latched';
	}
}

export async function cancelRecording() {
	// Note: distinct from the low-level Tauri `commands.cancelRecording()` (CPAL
	// stream teardown). This is the user-facing command: it decides what "cancel"
	// means across the manual and VAD recorders.
	//
	// Cancel aborts whichever capture is live, without touching `recording.mode`:
	// the chosen input mode (manual vs VAD) is a deliberate preference, not
	// something a cancel keystroke should flip, so cancelling in VAD mode leaves
	// you in VAD mode, idle and ready to listen again. This is also the global
	// cancel chord (Cmd + . on macOS), which the rdev hook observes on every
	// system press without swallowing it, so when nothing is live it stays silent
	// rather than toasting on an unrelated press.

	// A manual recording is the live capture: discard it.
	const { data, error } = await manualRecorder.cancelRecording();
	if (error) {
		report.error({ title: 'Failed to cancel recording', cause: error });
		return;
	}
	if (data.status === 'cancelled') {
		void recordingMedia.resume();
		sound.playSoundIfEnabled('manual-cancel');
		report.success({ title: '✅ Recording cancelled' });
		log.info('Recording cancelled');
		return;
	}

	// No manual recording, but a VAD session may be live. VAD has no
	// discard-vs-finalize split: tearing the session down is the only way to
	// abort it, which is exactly what stopVadRecording already does (same
	// stopActiveListening call, same end state, mode left on `vad`). So cancel a
	// live VAD session by stopping it, rather than cloning the teardown with a
	// second toast and a manual-recording sound. Nothing live: silent no-op.
	if (isVadRecordingActive()) await stopVadRecording();
}

export async function startVadRecording() {
	settings.set('recording.mode', 'vad');

	log.info('Starting voice activated capture');
	const loading = report.loading({
		title: '🎙️ Starting voice activated capture',
		description: 'Your voice activated capture is starting...',
	});

	recordingMedia.pause();

	const { data: outcome, error } = await vadRecorder.startActiveListening({
		onLevel: (level) => recordingOverlay.reportLevel(level),
		onSpeechStart: () => {
			report.success({
				title: '🎙️ Speech started',
				description: 'Recording started. Speak clearly and loudly.',
			});
		},
		onSpeechEnd: async (blob) => {
			report.success({
				title: '🎙️ Voice activated speech captured',
				description: 'Your voice activated speech has been captured.',
			});
			log.info('Voice activated speech captured');
			sound.playSoundIfEnabled('vad-capture');

			analytics.logEvent({
				type: 'vad_recording_completed',
				blob_size: blob.size,
			});

			await processRecordingPipeline({
				source: {
					kind: 'blob',
					blob,
					recordingId: nanoid(),
					durationMs: null,
				},
				durationMs: null,
			});
		},
	});

	if (error) {
		void recordingMedia.resume();
		loading.reject({ cause: error });
		return;
	}

	loading.resolve(
		handleDeviceAcquisitionOutcome(
			outcome,
			'🎙️ Voice activated capture started',
			'Your voice activated capture has been started.',
			(deviceId) => deviceConfig.set('recording.navigator.deviceId', deviceId),
		),
	);

	sound.playSoundIfEnabled('vad-start');
}

export async function stopVadRecording() {
	if (!isVadRecordingActive()) return;

	log.info('Stopping voice activated capture');
	const loading = report.loading({
		title: '⏸️ Stopping voice activated capture...',
		description: 'Finalizing your voice activated capture...',
	});
	const { data, error } = await vadRecorder.stopActiveListening();
	if (error) {
		void recordingMedia.resume();
		loading.reject({ cause: error });
		return;
	}
	const stoppedNotice = {
		title: '🎙️ Voice activated capture stopped',
		description: 'Your voice activated capture has been stopped.',
	};
	if (data.status === 'idle') {
		loading.resolve(stoppedNotice);
		return;
	}
	loading.resolve(stoppedNotice);
	sound.playSoundIfEnabled('vad-stop');
	void recordingMedia.resume();
}

export function toggleVadRecording() {
	if (isVadRecordingActive()) {
		return stopVadRecording();
	}
	return startVadRecording();
}
