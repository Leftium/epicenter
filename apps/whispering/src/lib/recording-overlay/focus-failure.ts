import { goto } from '$app/navigation';
import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/urls';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

/**
 * The failed pill's "open detail" gesture: land on the failed recording's row in
 * the recordings list, where the full error and Retry live (ADR-0029). The
 * recordings page reads the `focus` query param to scroll to and highlight the
 * row. A no-op unless the current dictation failed with a saved recording: a
 * silent loss has no row to open.
 */
export function openFailedDictationDetail(): void {
	const lifecycle = dictationLifecycle.current;
	if (lifecycle.phase !== 'failed' || !lifecycle.recordingId) return;
	void goto(`${WHISPERING_RECORDINGS_PATHNAME}?focus=${lifecycle.recordingId}`);
}
