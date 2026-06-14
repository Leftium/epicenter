// macOS permission probing for the setup wizard. A factory (not a module
// singleton): `createSetupPermissions()` is called once inside the wizard page,
// so the probe state lives on that component instance and resets when the
// wizard is re-entered, instead of persisting for the app's lifetime.

import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import {
	isAppleDesktop,
	type SetupPermissionState,
} from '$lib/setup/setup-readiness';

export function createSetupPermissions() {
	let microphone = $state<SetupPermissionState>('checking');
	let accessibility = $state<SetupPermissionState>('checking');

	return {
		get microphone() {
			return microphone;
		},
		get accessibility() {
			return accessibility;
		},
		async refresh() {
			// `!tauri` is redundant with `isAppleDesktop` at runtime, but it narrows
			// `tauri` to non-null for the permission probes below.
			if (!tauri || !isAppleDesktop) {
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
				report.error({
					title: 'Accessibility permission failed',
					cause: error,
				});
				return;
			}
			accessibility = data ? 'granted' : 'denied';
		},
	};
}

export type SetupPermissions = ReturnType<typeof createSetupPermissions>;
