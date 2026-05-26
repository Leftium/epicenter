import { desktopRpc } from '$lib/rpc/desktop';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';

export function syncIconWithRecorderState() {
	$effect(() => {
		desktopRpc.tray.setTrayIcon({ icon: manualRecorder.state });
	});
}
