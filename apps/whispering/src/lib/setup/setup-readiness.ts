import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import type { Command } from '$lib/commands';
import { toggleCommandIdForMode } from '$lib/constants/audio';
import { getTranscriptionSetupReadiness } from '$lib/settings/transcription-validation';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { permissions } from '$lib/state/permissions.svelte';
import { settings } from '$lib/state/settings.svelte';
import { isEmptyBinding } from '$lib/utils/key-binding';

/** Only the macOS desktop app needs microphone + accessibility grants. */
export const isAppleDesktop = Boolean(tauri && os.isApple);

/** A command's global (rdev) shortcut counts only when bound and non-empty. */
function hasGlobalBinding(id: Command['id']): boolean {
	const binding = deviceConfig.get(`shortcuts.global.${id}`);
	return binding != null && !isEmptyBinding(binding);
}

export type SetupReadiness = {
	runtimeReady: boolean;
	accessReady: boolean;
	activationReady: boolean;
	canFinish: boolean;
	primaryIssue: string | null;
	needsDesktopPermissions: boolean;
};

/**
 * Whether each setup step is satisfied, plus the one issue worth surfacing.
 * Reads the live settings, device config, and permission owner; safe to call
 * inside an effect since every input is reactive.
 */
export function getSetupReadiness(): SetupReadiness {
	const runtime = getTranscriptionSetupReadiness();
	const runtimeReady = runtime.isReady;

	const accessReady =
		!isAppleDesktop ||
		(permissions.microphone === 'granted' &&
			permissions.accessibility === 'granted');

	// One shortcut system per platform: the desktop app reads global (rdev)
	// KeyBindings, the browser reads in-app shortcut strings. A bound toggle OR
	// push-to-talk is enough to start a recording; upload mode needs neither.
	const recordingMode = settings.get('recording.mode');
	const toggleCommandId = toggleCommandIdForMode(recordingMode);
	const activationReady =
		recordingMode === 'upload' ||
		(tauri
			? hasGlobalBinding(toggleCommandId) || hasGlobalBinding('pushToTalk')
			: Boolean(
					settings.get(`shortcut.${toggleCommandId}`) ||
						settings.get('shortcut.pushToTalk'),
				));

	const canFinish = runtimeReady && accessReady && activationReady;
	const primaryIssue =
		runtime.primaryIssue ??
		(accessReady ? null : 'Grant desktop permissions to record and paste.') ??
		(activationReady ? null : 'Set a shortcut or choose Upload mode.');

	return {
		runtimeReady,
		accessReady,
		activationReady,
		canFinish,
		primaryIssue,
		needsDesktopPermissions: isAppleDesktop,
	};
}
