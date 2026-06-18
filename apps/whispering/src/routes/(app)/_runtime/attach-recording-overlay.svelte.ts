import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { recordingOverlay } from '#platform/recording-overlay';
import { tauri } from '#platform/tauri';
import {
	cancelRecording,
	stopManualRecording,
	stopVadRecording,
} from '$lib/operations/recording';
import {
	type RecordingOverlayStatus,
	recordingOverlayAction,
	recordingOverlayFocusMain,
} from '$lib/recording-overlay/events';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

export function attachRecordingOverlay() {
	let unlistenAction: UnlistenFn | undefined;
	let unlistenFocus: UnlistenFn | undefined;

	const overlayStatus = $derived.by((): RecordingOverlayStatus | null => {
		if (manualRecorder.state === 'RECORDING')
			return { trigger: 'manual', state: 'RECORDING' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { trigger: 'vad', state: vadRecorder.state };
		return null;
	});

	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	if (tauri) {
		void (async () => {
			unlistenAction = await recordingOverlayAction.listen((event) => {
				if (!overlayStatus) return;
				if (overlayStatus.trigger === 'manual') {
					if (event.payload === 'cancel') void cancelRecording();
					else void stopManualRecording();
					return;
				}
				if (event.payload === 'stop') void stopVadRecording();
			});
			unlistenFocus = await recordingOverlayFocusMain.listen(() => {
				const mainWindow = getCurrentWindow();
				void (async () => {
					await mainWindow.show();
					await mainWindow.unminimize();
					await mainWindow.setFocus().catch(() => {});
				})();
			});
		})();
	}

	return () => {
		unlistenAction?.();
		unlistenFocus?.();
	};
}
