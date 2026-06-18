import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { recordingOverlay } from '#platform/recording-overlay';
import { tauri } from '#platform/tauri';
import {
	cancelRecording,
	retryDictation,
	stopManualRecording,
	stopVadRecording,
} from '$lib/operations/recording';
import {
	RECORDING_OVERLAY_ACTION,
	RECORDING_OVERLAY_FOCUS_MAIN,
	type RecordingOverlayAction,
} from '$lib/recording-overlay/events';
import { openFailedDictationDetail } from '$lib/recording-overlay/focus-failure';
import { projectLifecycleToStatus } from '$lib/recording-overlay/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

export function attachRecordingOverlay() {
	let unlistenAction: UnlistenFn | undefined;
	let unlistenFocus: UnlistenFn | undefined;

	const overlayStatus = $derived(
		projectLifecycleToStatus(dictationLifecycle.current),
	);

	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	if (tauri) {
		void (async () => {
			unlistenAction = await listen<RecordingOverlayAction>(
				RECORDING_OVERLAY_ACTION,
				(event) => {
					if (event.payload === 'retry') {
						void retryDictation();
						return;
					}
					// Stop/cancel act on a live capture; ignore them otherwise.
					const lifecycle = dictationLifecycle.current;
					if (lifecycle.phase !== 'recording') return;
					if (lifecycle.trigger === 'manual') {
						if (event.payload === 'cancel') void cancelRecording();
						else void stopManualRecording();
						return;
					}
					if (event.payload === 'stop') void stopVadRecording();
				},
			);
			unlistenFocus = await listen(RECORDING_OVERLAY_FOCUS_MAIN, () => {
				const mainWindow = getCurrentWindow();
				void (async () => {
					await mainWindow.show();
					await mainWindow.unminimize();
					await mainWindow.setFocus().catch(() => {});
				})();
				// When the pill is reporting a failure, the body click also opens
				// the failed recording's row, the detail surface.
				openFailedDictationDetail();
			});
		})();
	}

	return () => {
		unlistenAction?.();
		unlistenFocus?.();
	};
}
