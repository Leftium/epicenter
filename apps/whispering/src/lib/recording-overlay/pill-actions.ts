import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import {
	cancelRecording,
	retryDictation,
	stopManualRecording,
	stopVadRecording,
} from '$lib/operations/recording';
import type { RecordingOverlayAction } from '$lib/recording-overlay/events';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

/**
 * The pill's control gestures, mapped to recorder operations in one place. Both
 * pill mounts route through here so the gesture-to-operation rules live once: the
 * web host calls these directly, and the Tauri main window calls them from the
 * overlay's action/focus IPC. The pill component itself stays presentational.
 */

/**
 * Apply a stop/cancel/retry gesture. Retry acts on a failed dictation; stop and
 * cancel act only on a live capture. VAD has no cancel (its pill shows no cancel
 * button), so a stray cancel during a VAD session is a no-op.
 */
export function dispatchPillAction(action: RecordingOverlayAction): void {
	if (action === 'retry') {
		void retryDictation();
		return;
	}
	const { capture } = dictationLifecycle.current;
	if (capture.kind !== 'recording') return;
	if (capture.trigger === 'manual') {
		if (action === 'cancel') void cancelRecording();
		else void stopManualRecording();
		return;
	}
	if (action === 'stop') void stopVadRecording();
}

/**
 * The failed pill's "open detail" gesture: land on the failed recording's row in
 * the recordings list, where the full error and Retry live (ADR-0029). The
 * recordings page reads the `focus` query param to scroll to and highlight the
 * row. A no-op unless a failure with a saved recording is showing: a silent loss
 * has no row to open.
 *
 * Opening the row is the latch's review action, so this prefers the latched VAD
 * failure (which persists past later utterances) and clears it on open, then
 * falls back to the current outcome for the manual/idle failed pill.
 *
 * The latch is only honored while VAD is live, matching the projection: disarm
 * and restart clear it, but a recorder death can leave it set while capture goes
 * idle, and an idle pill shows the current outcome, not the stale latch.
 */
export function openFailedDictationDetail(): void {
	const { capture, outcome, unreviewedFailure } = dictationLifecycle.current;
	const liveVadFailure =
		capture.kind === 'recording' && capture.trigger === 'vad'
			? unreviewedFailure
			: null;
	const failure =
		liveVadFailure ?? (outcome.kind === 'failed' ? outcome : null);
	if (!failure?.recordingId) return;
	dictationLifecycle.clearUnreviewedFailure();
	void goto(`${WHISPERING_RECORDINGS_PATHNAME}?focus=${failure.recordingId}`);
}
