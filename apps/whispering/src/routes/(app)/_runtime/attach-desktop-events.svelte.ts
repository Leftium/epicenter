import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';
import { globalListener } from '$lib/state/global-listener.svelte';
import { localModel } from '$lib/state/local-model.svelte';
import { permissions } from '$lib/state/permissions.svelte';
import { checkForUpdates } from './check-for-updates';

export function attachDesktopEvents() {
	let unlistenNavigate: UnlistenFn | undefined;
	let unlistenLocalModel: UnlistenFn | undefined;
	let cleanupPermissions: (() => void) | undefined;
	let cleanupGlobalListener: (() => void) | undefined;

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
			cleanupPermissions = permissions.attach();
			cleanupGlobalListener = globalListener.attach();
		})();
	}

	return () => {
		unlistenNavigate?.();
		unlistenLocalModel?.();
		cleanupPermissions?.();
		cleanupGlobalListener?.();
	};
}
