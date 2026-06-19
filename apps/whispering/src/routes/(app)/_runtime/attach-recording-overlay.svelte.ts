import type { UnlistenFn } from '@tauri-apps/api/event';
import { recordingOverlay } from '#platform/recording-overlay';
import { tauri } from '#platform/tauri';
import {
	recordingOverlayAction,
	recordingOverlayFocusFailure,
} from '$lib/recording-overlay/events';
import {
	dispatchPillAction,
	openFailedDictationDetail,
} from '$lib/recording-overlay/pill-actions';
import { projectLifecycleToStatus } from '$lib/recording-overlay/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

export function attachRecordingOverlay() {
	let unlistenAction: UnlistenFn | undefined;
	let unlistenFocusFailure: UnlistenFn | undefined;

	const overlayStatus = $derived(
		projectLifecycleToStatus(dictationLifecycle.current),
	);

	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	if (tauri) {
		void (async () => {
			unlistenAction = await recordingOverlayAction.listen((event) =>
				dispatchPillAction(event.payload),
			);
			// The pill body click raises the main window through the shared
			// `revealMainWindow` (attachMainWindowReveal owns the raise). It also
			// fires this so the main window, which owns the dictation lifecycle, can
			// open the failed recording's row and clear the latch. A no-op unless a
			// failure is showing.
			unlistenFocusFailure = await recordingOverlayFocusFailure.listen(() => {
				openFailedDictationDetail();
			});
		})();
	}

	return () => {
		unlistenAction?.();
		unlistenFocusFailure?.();
	};
}
