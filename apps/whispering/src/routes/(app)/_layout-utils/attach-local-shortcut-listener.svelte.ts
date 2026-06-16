import { dispatchCommandTrigger } from '$lib/commands';
import { services } from '$lib/services';

export function attachLocalShortcutListener() {
	$effect(() => {
		const unlisten = services.localShortcutManager.listen(dispatchCommandTrigger);
		return () => unlisten();
	});

	return () => {};
}
