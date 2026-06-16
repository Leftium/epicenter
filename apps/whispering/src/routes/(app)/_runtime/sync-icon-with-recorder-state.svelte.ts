/**
 * Owns the desktop tray icon mirror for the manual recorder state.
 */

import { tauri } from '#platform/tauri';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';

export const syncIconWithRecorderStateRuntime = {
	attach() {
		$effect(() => {
			if (!tauri) return;
			void tauri.tray.setIcon({ icon: manualRecorder.state });
		});
	},
};
