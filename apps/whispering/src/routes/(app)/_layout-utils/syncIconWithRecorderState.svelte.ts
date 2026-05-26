import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import type { Tauri } from '$lib/tauri';

export function syncIconWithRecorderState(tauri: Tauri) {
	$effect(() => {
		void tauri.tray.setIcon({ icon: manualRecorder.state });
	});
}
