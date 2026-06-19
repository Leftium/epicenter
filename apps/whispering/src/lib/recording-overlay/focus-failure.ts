import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

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
 */
export function openFailedDictationDetail(): void {
	const { outcome, unreviewedFailure } = dictationLifecycle.current;
	const failure =
		unreviewedFailure ?? (outcome.kind === 'failed' ? outcome : null);
	if (!failure?.recordingId) return;
	dictationLifecycle.clearUnreviewedFailure();
	void goto(`${WHISPERING_RECORDINGS_PATHNAME}?focus=${failure.recordingId}`);
}
