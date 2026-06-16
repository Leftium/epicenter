/**
 * Owns the recorder-to-overlay status projection shared by overlay rendering
 * and overlay click handling.
 */

import type { RecordingOverlayStatus } from '$lib/recording-overlay/events';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

export function getRecordingOverlayStatus(): RecordingOverlayStatus | null {
	if (manualRecorder.state === 'RECORDING')
		return { mode: 'manual', state: 'RECORDING' };
	if (
		vadRecorder.state === 'LISTENING' ||
		vadRecorder.state === 'SPEECH_DETECTED'
	)
		return { mode: 'vad', state: vadRecorder.state };
	return null;
}
