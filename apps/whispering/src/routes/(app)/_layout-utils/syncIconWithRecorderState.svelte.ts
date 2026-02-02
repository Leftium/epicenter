import { createQuery } from '@tanstack/svelte-query';
import { desktopRpc, rpc } from '$lib/query';

export function syncIconWithRecorderState() {
	const getRecorderStateQuery = createQuery(
		() => rpc.recorder.getRecorderState.options,
	);

	$effect(() => {
		if (getRecorderStateQuery.data) {
			desktopRpc.tray.setTrayIcon({
				icon: getRecorderStateQuery.data,
			});
		}
	});
}
