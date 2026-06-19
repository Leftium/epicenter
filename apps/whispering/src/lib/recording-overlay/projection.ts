import type { DictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import type { RecordingOverlayStatus, VadOutcomePip } from './events';

/**
 * Project the main window's dictation lifecycle into the serializable status the
 * pill renders. A live capture is the pill's primary content; when capture is
 * idle (manual after stop, a VAD session after disarm) the outcome takes the
 * pill. `idle`/`none` hides the pill (`null`). The live error object is dropped
 * in favor of a terse `title`, because the pill display must cross Tauri IPC on
 * desktop and the full failure detail lives on the recordings row.
 *
 * Shared by both pill mounts so desktop and web project identically: the Tauri
 * driver (`attach-recording-overlay`) sends the result over IPC; the web host
 * (`RecordingPillHost`) feeds it to the same component directly.
 */
export function projectLifecycleToStatus(
	lifecycle: DictationLifecycle,
): RecordingOverlayStatus | null {
	const { capture, outcome, unreviewedFailure } = lifecycle;

	// A live capture owns the pill: the recording meter is the primary content.
	// A VAD session also carries the concurrent utterance work as a side pip,
	// where a latched failure outranks an in-flight transcribe (failure breaks
	// through). Success earns no pip.
	if (capture.kind === 'recording') {
		if (capture.trigger === 'manual')
			return { phase: 'recording', trigger: 'manual' };
		const pip: VadOutcomePip | undefined = unreviewedFailure
			? 'failed'
			: outcome.kind === 'transcribing'
				? 'transcribing'
				: undefined;
		return {
			phase: 'recording',
			trigger: 'vad',
			vadState: capture.vadState,
			pip,
		};
	}

	// Capture is idle, so the outcome is the pill's content. This is the manual
	// post-stop flow and a VAD session's last outcome after disarm.
	switch (outcome.kind) {
		case 'none':
			return null;
		case 'transcribing':
			return { phase: 'transcribing' };
		case 'delivered':
			return { phase: 'delivered', reach: outcome.reach };
		case 'failed':
			return {
				phase: 'failed',
				tier: outcome.tier,
				title: outcome.error.message,
			};
	}
}
