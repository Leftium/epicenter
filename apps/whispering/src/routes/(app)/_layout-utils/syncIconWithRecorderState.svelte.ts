import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import type { Tauri } from '#platform/tauri';

export function syncIconWithRecorderState(tauri: Tauri) {
	$effect(() => {
		void tauri.tray.setIcon({ icon: manualRecorder.state });
	});
}
