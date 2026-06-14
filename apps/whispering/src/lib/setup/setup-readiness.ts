import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { getTranscriptionSetupReadiness } from '$lib/settings/transcription-validation';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { isEmptyBinding } from '$lib/utils/key-binding';

/** A global (rdev) shortcut counts only when it's bound and non-empty. */
function hasGlobalBinding(
	key:
		| 'shortcuts.global.toggleManualRecording'
		| 'shortcuts.global.toggleVadRecording'
		| 'shortcuts.global.pushToTalk',
): boolean {
	const binding = deviceConfig.get(key);
	return binding != null && !isEmptyBinding(binding);
}

export type SetupPermissionState = 'checking' | 'granted' | 'denied';

/** Probed permission state, threaded in by whoever owns the probe. */
export type SetupPermissions = {
	microphonePermission?: SetupPermissionState;
	accessibilityPermission?: SetupPermissionState;
};

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
 * Permissions are passed in so this stays a pure function shared by the live
 * wizard (reactive permission state) and the startup nudge (one-shot probe).
 */
export function getSetupReadiness({
	microphonePermission = 'granted',
	accessibilityPermission = 'granted',
}: SetupPermissions = {}): SetupReadiness {
	const runtime = getTranscriptionSetupReadiness();
	const runtimeReady = runtime.isReady;

	const needsDesktopPermissions = Boolean(tauri && os.isApple);
	const accessReady =
		!needsDesktopPermissions ||
		(microphonePermission === 'granted' &&
			accessibilityPermission === 'granted');

	// One shortcut system per platform: the desktop app reads global (rdev)
	// KeyBindings, the browser reads in-app shortcut strings. A bound toggle OR
	// push-to-talk is enough to start a recording; upload mode needs neither.
	const recordingMode = settings.get('recording.mode');
	const toggleCommandId =
		recordingMode === 'vad' ? 'toggleVadRecording' : 'toggleManualRecording';
	const activationReady =
		recordingMode === 'upload' ||
		(tauri
			? hasGlobalBinding(`shortcuts.global.${toggleCommandId}`) ||
				hasGlobalBinding('shortcuts.global.pushToTalk')
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
		needsDesktopPermissions,
	};
}
