import type { Tauri } from '$lib/tauri';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';

export function syncIconWithRecorderState(tauri: Tauri) {
	$effect(() => {
		void tauri.tray.setIcon({ icon: manualRecorder.state });
	});
}
