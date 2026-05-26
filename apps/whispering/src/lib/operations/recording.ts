import { nanoid } from 'nanoid/non-secure';
import { analytics } from '$lib/operations/analytics';
import { notify } from '$lib/operations/notify';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { sound } from '$lib/operations/sound';
import type {
	DeviceAcquisitionOutcome,
	UpdateStatusMessageFn,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

const sendStatusToToast =
	(toastId: string): UpdateStatusMessageFn =>
	(status) =>
		notify.loading({ id: toastId, ...status });

function handleDeviceAcquisitionOutcome(
	outcome: DeviceAcquisitionOutcome,
	toastId: string,
	successTitle: string,
	successDescription: string,
	persist: (deviceId: string) => void,
) {
	if (outcome.outcome === 'success') {
		notify.success({
			id: toastId,
			title: successTitle,
			description: successDescription,
		});
		return;
	}

	persist(outcome.deviceId);
	switch (outcome.reason) {
		case 'no-device-selected': {
			notify.info({
				id: toastId,
				title: '🎙️ Switched to available microphone',
				description:
					'No microphone was selected, so we automatically connected to an available one. You can update your selection in settings.',
				action: {
					type: 'link',
					label: 'Open Settings',
					href: '/settings/recording',
				},
			});
			break;
		}
		case 'preferred-device-unavailable': {
			notify.info({
				id: toastId,
				title: "🎙️ Switched to different microphone",
				description:
					"Your previously selected microphone wasn't found, so we automatically connected to an available one.",
				action: {
					type: 'link',
					label: 'Open Settings',
					href: '/settings/recording',
				},
			});
			break;
		}
	}
}

export async function startManualRecording() {
	settings.set('recording.mode', 'manual');

	const toastId = nanoid();
	notify.loading({
		id: toastId,
		title: '🎙️ Preparing to record...',
		description: 'Setting up your recording environment...',
	});

	const { data: outcome, error } = await manualRecorder.start({
		sendStatus: sendStatusToToast(toastId),
	});

	if (error) {
		notify.error({
			id: toastId,
			title: '❌ Failed to start recording',
			description: error.message,
			action: { type: 'more-details', error },
		});
		return;
	}

	if (!outcome) {
		notify.dismiss(toastId);
		return;
	}

	handleDeviceAcquisitionOutcome(
		outcome,
		toastId,
		'🎙️ Whispering is recording...',
		'Speak now and stop recording when done',
		(deviceId) => {
			const method = deviceConfig.get('recording.method');
			deviceConfig.set(`recording.${method}.deviceId`, deviceId);
		},
	);

	console.info('Recording started');
	sound.playSoundIfEnabled('manual-start');
}

export async function stopManualRecording() {
	const toastId = nanoid();
	notify.loading({
		id: toastId,
		title: '⏸️ Stopping recording...',
		description: 'Finalizing your audio capture...',
	});

	const { data, error } = await manualRecorder.stop({
		sendStatus: sendStatusToToast(toastId),
	});

	if (error) {
		notify.error({
			id: toastId,
			title: '❌ Failed to stop recording',
			description: error.message,
			action: { type: 'more-details', error },
		});
		return;
	}

	if (!data) {
		notify.dismiss(toastId);
		return;
	}

	const { blob, recordingId, duration } = data;

	notify.success({
		id: toastId,
		title: '🎙️ Recording stopped',
		description: 'Your recording has been saved',
	});
	console.info('Recording stopped');
	sound.playSoundIfEnabled('manual-stop');

	analytics.logEvent({
		type: 'manual_recording_completed',
		blob_size: blob.size,
		duration,
	});

	await processRecordingPipeline({
		blob,
		recordingId,
		toastId,
		completionTitle: '✨ Recording Complete!',
		completionDescription: 'Recording saved and session closed successfully',
	});
}

export async function toggleManualRecording() {
	if (manualRecorder.state === 'RECORDING') {
		return await stopManualRecording();
	}
	return await startManualRecording();
}

export async function cancelManualRecording() {
	const toastId = nanoid();
	notify.loading({
		id: toastId,
		title: '⏸️ Canceling recording...',
		description: 'Cleaning up recording session...',
	});

	const { data, error } = await manualRecorder.cancel({
		sendStatus: sendStatusToToast(toastId),
	});

	if (error) {
		notify.error({
			id: toastId,
			title: '❌ Failed to cancel recording',
			description: error.message,
			action: { type: 'more-details', error },
		});
		return;
	}

	if (!data) {
		notify.dismiss(toastId);
		return;
	}

	switch (data.status) {
		case 'no-recording': {
			notify.info({
				id: toastId,
				title: 'No active recording',
				description: 'There is no recording in progress to cancel.',
			});
			break;
		}
		case 'cancelled': {
			notify.success({
				id: toastId,
				title: '✅ All Done!',
				description: 'Recording cancelled successfully',
			});
			sound.playSoundIfEnabled('manual-cancel');
			console.info('Recording cancelled');
			break;
		}
	}
}

export async function startVadRecording() {
	settings.set('recording.mode', 'vad');

	const toastId = nanoid();
	console.info('Starting voice activated capture');
	notify.loading({
		id: toastId,
		title: '🎙️ Starting voice activated capture',
		description: 'Your voice activated capture is starting...',
	});

	const { data: outcome, error } = await vadRecorder.startActiveListening({
		onSpeechStart: () => {
			notify.success({
				title: '🎙️ Speech started',
				description: 'Recording started. Speak clearly and loudly.',
			});
		},
		onSpeechEnd: async (blob) => {
			const speechToastId = nanoid();
			notify.success({
				id: speechToastId,
				title: '🎙️ Voice activated speech captured',
				description: 'Your voice activated speech has been captured.',
			});
			console.info('Voice activated speech captured');
			sound.playSoundIfEnabled('vad-capture');

			analytics.logEvent({
				type: 'vad_recording_completed',
				blob_size: blob.size,
			});

			await processRecordingPipeline({
				blob,
				toastId: speechToastId,
				completionTitle: '✨ Voice activated capture complete!',
				completionDescription:
					'Voice activated capture complete! Ready for another take',
			});
		},
	});

	if (error) {
		notify.error({ id: toastId, ...error });
		return;
	}

	handleDeviceAcquisitionOutcome(
		outcome,
		toastId,
		'🎙️ Voice activated capture started',
		'Your voice activated capture has been started.',
		(deviceId) => deviceConfig.set('recording.navigator.deviceId', deviceId),
	);

	sound.playSoundIfEnabled('vad-start');
}

export async function stopVadRecording() {
	const toastId = nanoid();
	console.info('Stopping voice activated capture');
	notify.loading({
		id: toastId,
		title: '⏸️ Stopping voice activated capture...',
		description: 'Finalizing your voice activated capture...',
	});
	const { error } = await vadRecorder.stopActiveListening();
	if (error) {
		notify.error({ id: toastId, ...error });
		return;
	}
	notify.success({
		id: toastId,
		title: '🎙️ Voice activated capture stopped',
		description: 'Your voice activated capture has been stopped.',
	});
	sound.playSoundIfEnabled('vad-stop');
}

export async function toggleVadRecording() {
	if (
		vadRecorder.state === 'LISTENING' ||
		vadRecorder.state === 'SPEECH_DETECTED'
	) {
		return await stopVadRecording();
	}
	return await startVadRecording();
}
