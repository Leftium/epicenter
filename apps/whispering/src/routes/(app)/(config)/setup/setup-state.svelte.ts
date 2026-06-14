// Shared reactive state for the setup wizard: macOS permission probing,
// practice-success tracking, and a readiness snapshot derived from current
// settings. The step components and the page host read from here so probing
// happens once and every step sees the same live state.

import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import {
	getSetupReadiness,
	type SetupPermissionState,
} from '$lib/setup/setup-readiness';

let microphone = $state<SetupPermissionState>('checking');
let accessibility = $state<SetupPermissionState>('checking');

export const permissions = {
	get microphone() {
		return microphone;
	},
	get accessibility() {
		return accessibility;
	},
	async refresh() {
		if (!tauri || !os.isApple) {
			microphone = 'granted';
			accessibility = 'granted';
			return;
		}

		microphone = 'checking';
		accessibility = 'checking';

		const [mic, acc] = await Promise.all([
			tauri.permissions.microphone.check(),
			tauri.permissions.accessibility.check(),
		]);

		microphone = mic.data ? 'granted' : 'denied';
		accessibility = acc.data ? 'granted' : 'denied';
	},
	async requestMicrophone() {
		if (!tauri) return;
		microphone = 'checking';
		const { data, error } = await tauri.permissions.microphone.request();
		if (error) {
			microphone = 'denied';
			report.error({ title: 'Microphone permission failed', cause: error });
			return;
		}
		microphone = data ? 'granted' : 'denied';
	},
	async requestAccessibility() {
		if (!tauri) return;
		accessibility = 'checking';
		const { data, error } = await tauri.permissions.accessibility.request();
		if (error) {
			accessibility = 'denied';
			report.error({ title: 'Accessibility permission failed', cause: error });
			return;
		}
		accessibility = data ? 'granted' : 'denied';
	},
};

let practiceSucceeded = $state(false);

export const practice = {
	get succeeded() {
		return practiceSucceeded;
	},
	markSucceeded() {
		practiceSucceeded = true;
	},
};

/**
 * Readiness derived from current settings + probed permissions. Call inside a
 * `$derived(...)` in each variant so it stays reactive.
 */
export function getReadiness() {
	return getSetupReadiness({
		microphonePermission: microphone,
		accessibilityPermission: accessibility,
	});
}
