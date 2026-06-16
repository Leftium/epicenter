/**
 * Owns desktop-only launch listeners: updates, navigation events, overlay
 * actions, overlay focus, and local-model lifecycle events.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { goto } from '$app/navigation';
import {
	cancelRecording,
	stopManualRecording,
	stopVadRecording,
} from '$lib/operations/recording';
import {
	RECORDING_OVERLAY_ACTION,
	RECORDING_OVERLAY_FOCUS_MAIN,
	type RecordingOverlayAction,
} from '$lib/recording-overlay/events';
import { localModel } from '$lib/state/local-model.svelte';
import { tauri } from '#platform/tauri';
import { checkForUpdates } from './check-for-updates.js';
import { getRecordingOverlayStatus } from './recording-overlay-status.js';

export const nativeRuntime = {
	attach() {
		if (!tauri) return;

		let detached = false;
		let unlistenNavigate: UnlistenFn | undefined;
		let unlistenLocalModel: UnlistenFn | undefined;
		let unlistenOverlayAction: UnlistenFn | undefined;
		let unlistenOverlayFocus: UnlistenFn | undefined;

		void checkForUpdates();

		void (async () => {
			unlistenNavigate = await listen<{ path: string }>(
				'navigate-main-window',
				(event) => {
					goto(event.payload.path);
				},
			);
			if (detached) {
				unlistenNavigate();
				return;
			}

			unlistenOverlayAction = await listen<RecordingOverlayAction>(
				RECORDING_OVERLAY_ACTION,
				(event) => {
					const overlayStatus = getRecordingOverlayStatus();
					if (!overlayStatus) return;
					if (overlayStatus.mode === 'manual') {
						if (event.payload === 'cancel') void cancelRecording();
						else void stopManualRecording();
						return;
					}
					if (event.payload === 'stop') void stopVadRecording();
				},
			);
			if (detached) {
				unlistenOverlayAction();
				return;
			}

			unlistenOverlayFocus = await listen(RECORDING_OVERLAY_FOCUS_MAIN, () => {
				const mainWindow = getCurrentWindow();
				void (async () => {
					await mainWindow.show();
					await mainWindow.unminimize();
					await mainWindow.setFocus().catch(() => {});
				})();
			});
			if (detached) {
				unlistenOverlayFocus();
				return;
			}

			unlistenLocalModel = await localModel.attach();
			if (detached) unlistenLocalModel();
		})();

		return () => {
			detached = true;
			unlistenNavigate?.();
			unlistenOverlayAction?.();
			unlistenOverlayFocus?.();
			unlistenLocalModel?.();
		};
	},
};
