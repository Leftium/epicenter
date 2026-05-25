import { nanoid } from 'nanoid/non-secure';
import { analytics } from '$lib/operations/analytics';
import { notify } from '$lib/operations/notify';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { sound } from '$lib/operations/sound';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

let manualRecordingStartTime: number | null = null;

/**
 * Mutex flag to prevent concurrent recording operations.
 *
 * Guards against a race condition where rapid toggle calls (e.g., push-to-talk)
 * can both see 'IDLE' state before the recorder has fully started:
 * 1. Call 1 checks recorder state -> IDLE (during setup, is_recording not yet true)
 * 2. Call 2 checks recorder state -> IDLE (Call 1's recording hasn't fully started)
 * 3. Both calls try to start recording, causing state desync.
 *
 * Set synchronously at the start of any recording operation and cleared
 * when the core operation completes (after the recorder service call returns).
 */
let isRecordingOperationBusy = false;

export async function startManualRecording() {
	if (isRecordingOperationBusy) {
		console.info('Recording operation already in progress, ignoring start');
		return;
	}
	isRecordingOperationBusy = true;

	settings.set('recording.mode', 'manual');

	const toastId = nanoid();
	notify.loading({
		id: toastId,
		title: '🎙️ Preparing to record...',
		description: 'Setting up your recording environment...',
	});

	const { data: deviceAcquisitionOutcome, error: startRecordingError } =
		await manualRecorder.startRecording({ toastId });

	isRecordingOperationBusy = false;

	if (startRecordingError) {
		notify.error({ id: toastId, ...startRecordingError });
		return;
	}

	switch (deviceAcquisitionOutcome.outcome) {
		case 'success': {
			notify.success({
				id: toastId,
				title: '🎙️ Whispering is recording...',
				description: 'Speak now and stop recording when done',
			});
			break;
		}
		case 'fallback': {
			const method = deviceConfig.get('recording.method');
			deviceConfig.set(
				`recording.${method}.deviceId`,
				deviceAcquisitionOutcome.deviceId,
			);
			switch (deviceAcquisitionOutcome.reason) {
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
						title: '🎙️ Switched to different microphone',
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
	}
	manualRecordingStartTime = Date.now();
	console.info('Recording started');
	sound.playSoundIfEnabled('manual-start');
}

export async function stopManualRecording() {
	if (isRecordingOperationBusy) {
		console.info('Recording operation already in progress, ignoring stop');
		return;
	}
	isRecordingOperationBusy = true;

	const toastId = nanoid();
	notify.loading({
		id: toastId,
		title: '⏸️ Stopping recording...',
		description: 'Finalizing your audio capture...',
	});

	const { data, error: stopRecordingError } =
		await manualRecorder.stopRecording({ toastId });

	// Release mutex after the actual stop operation completes.
	// New recordings can start while the pipeline runs.
	isRecordingOperationBusy = false;

	if (stopRecordingError) {
		notify.error({ id: toastId, ...stopRecordingError });
		return;
	}

	const { blob, recordingId } = data;

	notify.success({
		id: toastId,
		title: '🎙️ Recording stopped',
		description: 'Your recording has been saved',
	});
	console.info('Recording stopped');
	sound.playSoundIfEnabled('manual-stop');

	let duration: number | undefined;
	if (manualRecordingStartTime) {
		duration = Date.now() - manualRecordingStartTime;
		manualRecordingStartTime = null;
	}
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
	if (isRecordingOperationBusy) {
		console.info('Recording operation already in progress, ignoring cancel');
		return;
	}
	isRecordingOperationBusy = true;

	const toastId = nanoid();
	notify.loading({
		id: toastId,
		title: '⏸️ Canceling recording...',
		description: 'Cleaning up recording session...',
	});
	const { data: cancelRecordingResult, error: cancelRecordingError } =
		await manualRecorder.cancelRecording({ toastId });

	isRecordingOperationBusy = false;

	if (cancelRecordingError) {
		notify.error({ id: toastId, ...cancelRecordingError });
		return;
	}
	switch (cancelRecordingResult.status) {
		case 'no-recording': {
			notify.info({
				id: toastId,
				title: 'No active recording',
				description: 'There is no recording in progress to cancel.',
			});
			break;
		}
		case 'cancelled': {
			manualRecordingStartTime = null;
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
	const { data: deviceAcquisitionOutcome, error: startActiveListeningError } =
		await vadRecorder.startActiveListening({
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
	if (startActiveListeningError) {
		notify.error({ id: toastId, ...startActiveListeningError });
		return;
	}

	switch (deviceAcquisitionOutcome.outcome) {
		case 'success': {
			notify.success({
				id: toastId,
				title: '🎙️ Voice activated capture started',
				description: 'Your voice activated capture has been started.',
			});
			break;
		}
		case 'fallback': {
			deviceConfig.set(
				'recording.navigator.deviceId',
				deviceAcquisitionOutcome.deviceId,
			);
			switch (deviceAcquisitionOutcome.reason) {
				case 'no-device-selected': {
					notify.info({
						id: toastId,
						title: '🎙️ VAD started with available microphone',
						description:
							'No microphone was selected for VAD, so we automatically connected to an available one. You can update your selection in settings.',
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
						title: '🎙️ VAD switched to different microphone',
						description:
							"Your previously selected VAD microphone wasn't found, so we automatically connected to an available one.",
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
	}

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
	const { error: stopVadError } = await vadRecorder.stopActiveListening();
	if (stopVadError) {
		notify.error({ id: toastId, ...stopVadError });
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
