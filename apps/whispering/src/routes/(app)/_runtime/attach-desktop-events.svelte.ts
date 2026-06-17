import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';
import { dictationCapability } from '$lib/state/dictation-capability.svelte';
import { localModel } from '$lib/state/local-model.svelte';
import { checkForUpdates } from './check-for-updates';

export function attachDesktopEvents() {
	let unlistenNavigate: UnlistenFn | undefined;
	let unlistenLocalModel: UnlistenFn | undefined;
	let cleanupCapability: (() => void) | undefined;

	if (tauri) {
		void checkForUpdates();
		void (async () => {
			unlistenNavigate = await listen<{ path: string }>(
				'navigate-main-window',
				(event) => {
					goto(event.payload.path);
				},
			);
			unlistenLocalModel = await localModel.attach();
			cleanupCapability = dictationCapability.attach();
		})();
	}

	return () => {
		unlistenNavigate?.();
		unlistenLocalModel?.();
		cleanupCapability?.();
	};
}
