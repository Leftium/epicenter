import type { DictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import type { RecordingOverlayStatus } from './events';

/**
 * Project the main window's rich dictation lifecycle into the serializable
 * status the pill renders. `idle` hides the pill (`null`). The live error object
 * is dropped in favor of a terse `title`, because the pill display must cross
 * Tauri IPC on desktop and the full failure detail lives on the recordings row.
 *
 * Shared by both pill mounts so desktop and web project identically: the Tauri
 * driver (`attach-recording-overlay`) sends the result over IPC; the web host
 * (`RecordingPillHost`) feeds it to the same component directly.
 */
export function projectLifecycleToStatus(
	lifecycle: DictationLifecycle,
): RecordingOverlayStatus | null {
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
			return { phase: 'delivered', degraded: lifecycle.degraded };
		case 'failed':
			return {
				phase: 'failed',
				tier: lifecycle.tier,
				title: lifecycle.error.message,
			};
	}
}
