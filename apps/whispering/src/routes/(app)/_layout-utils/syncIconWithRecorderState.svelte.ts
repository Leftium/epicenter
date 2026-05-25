import { desktopRpc } from '$lib/query/desktop';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';

export function syncIconWithRecorderState() {
	$effect(() => {
		desktopRpc.tray.setTrayIcon({ icon: manualRecorder.state });
	});
}
