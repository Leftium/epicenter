/**
 * Owns the live mirror from the active recorder state into the recording
 * overlay window.
 */

import { recordingOverlay } from '#platform/recording-overlay';
import { getRecordingOverlayStatus } from './recording-overlay-status.js';

export const recordingOverlayRuntime = {
	attach() {
		$effect(() => {
			recordingOverlay.sync(getRecordingOverlayStatus());
		});
	},
};
