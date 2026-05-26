import tauri from '$lib/tauri';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';

export function syncIconWithRecorderState() {
	$effect(() => {
		void tauri?.rpc.tray.setIcon({ icon: manualRecorder.state });
	});
}
