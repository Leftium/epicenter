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
	type RecordingOverlayStatus,
} from '$lib/recording-overlay/events';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

/**
 * Project the main window's dictation lifecycle into the serializable status the
 * overlay pill renders. `idle` hides the pill (`null`). The live error object
 * stays in the main window (it cannot cross Tauri IPC and the failure detail
 * lives on the recordings row); only a terse title is sent to the overlay.
 */
function toOverlayStatus(): RecordingOverlayStatus | null {
	const lifecycle = dictationLifecycle.current;
	switch (lifecycle.phase) {
		case 'idle':
			return null;
		case 'recording':
			return lifecycle.trigger === 'manual'
				? { phase: 'recording', trigger: 'manual' }
				: { phase: 'recording', trigger: 'vad', vadState: lifecycle.vadState };
		case 'transcribing':
			return { phase: 'transcribing' };
		case 'delivered':
			return { phase: 'delivered' };
		case 'failed':
			return {
				phase: 'failed',
				tier: lifecycle.tier,
				title: lifecycle.error.message,
			};
	}
}

export function attachRecordingOverlay() {
	let unlistenAction: UnlistenFn | undefined;
	let unlistenFocus: UnlistenFn | undefined;

	const overlayStatus = $derived(toOverlayStatus());

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
			});
		})();
	}

	return () => {
		unlistenAction?.();
		unlistenFocus?.();
	};
}
