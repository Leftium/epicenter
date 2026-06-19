import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { recordingOverlay } from '#platform/recording-overlay';
import { tauri } from '#platform/tauri';
import {
	RECORDING_OVERLAY_ACTION,
	RECORDING_OVERLAY_FOCUS_MAIN,
	type RecordingOverlayAction,
} from '$lib/recording-overlay/events';
import {
	dispatchPillAction,
	openFailedDictationDetail,
} from '$lib/recording-overlay/pill-actions';
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
				(event) => dispatchPillAction(event.payload),
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
