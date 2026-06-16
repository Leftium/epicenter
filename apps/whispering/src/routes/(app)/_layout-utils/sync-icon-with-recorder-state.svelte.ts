import type { Tauri } from '#platform/tauri';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { tauri } from '#platform/tauri';
import { syncWindowAlwaysOnTopWithRecorderState } from './alwaysOnTop.svelte';

export function syncIconWithRecorderState(tauri: Tauri) {
	$effect(() => {
		void tauri.tray.setIcon({ icon: manualRecorder.state });
	});
}

export function attachSyncIconWithRecorderState() {
	if (tauri) {
		syncWindowAlwaysOnTopWithRecorderState(tauri);
		syncIconWithRecorderState(tauri);
	}

	return () => {};
}
