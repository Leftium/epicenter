import { nanoid } from 'nanoid/non-secure';
import { manualRecorderConfig } from '#platform/manual-recorder-config';
import { recordingOverlay } from '#platform/recording-overlay';
import { goto } from '$app/navigation';
import { analytics } from '$lib/operations/analytics';
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

export async function startManualRecording() {
	settings.set('recording.mode', 'manual');

	const loading = report.loading({
		title: '🎙️ Preparing to record...',
		description: 'Setting up your recording environment...',
	});

	const { data: outcome, error } = await manualRecorder.startRecording();

	if (error) {
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

export async function cancelManualRecording() {
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
		sound.playSoundIfEnabled('manual-cancel');
		report.success({
			title: '✅ Recording cancelled',
			description: 'Recording cancelled successfully',
		});
		log.info('Recording cancelled');
		return;
	}

	// No manual recording, but a VAD session may be the live capture instead.
	const isVadActive =
		vadRecorder.state === 'LISTENING' ||
		vadRecorder.state === 'SPEECH_DETECTED';
	if (isVadActive) {
		const { error: vadError } = await vadRecorder.stopActiveListening();
		if (vadError) {
			report.error({
				title: 'Failed to cancel voice activated capture',
				cause: vadError,
			});
			return;
		}
		sound.playSoundIfEnabled('manual-cancel');
		report.success({
			title: '✅ Voice activated capture cancelled',
			description: 'Voice activated capture cancelled successfully',
		});
		log.info('Voice activated capture cancelled');
		return;
	}

	// Nothing live: silent no-op (see the note above).
}

export async function startVadRecording() {
	settings.set('recording.mode', 'vad');

	log.info('Starting voice activated capture');
	const loading = report.loading({
		title: '🎙️ Starting voice activated capture',
		description: 'Your voice activated capture is starting...',
	});

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
	log.info('Stopping voice activated capture');
	const loading = report.loading({
		title: '⏸️ Stopping voice activated capture...',
		description: 'Finalizing your voice activated capture...',
	});
	const { error } = await vadRecorder.stopActiveListening();
	if (error) {
		loading.reject({ cause: error });
		return;
	}
	loading.resolve({
		title: '🎙️ Voice activated capture stopped',
		description: 'Your voice activated capture has been stopped.',
	});
	sound.playSoundIfEnabled('vad-stop');
}

export function toggleVadRecording() {
	if (
		vadRecorder.state === 'LISTENING' ||
		vadRecorder.state === 'SPEECH_DETECTED'
	) {
		return stopVadRecording();
	}
	return startVadRecording();
}
