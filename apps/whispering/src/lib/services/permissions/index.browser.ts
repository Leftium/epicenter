/**
 * Web stub for a Tauri-only service. See `index.tauri.ts`.
 */

function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}

export const PermissionsError = {
	AccessibilityCheckFailed: unreachable,
	AccessibilityRequestFailed: unreachable,
	MicrophoneCheckFailed: unreachable,
	MicrophoneRequestFailed: unreachable,
} as unknown as typeof import('./index.tauri').PermissionsError;

export const PermissionsServiceLive = {
	accessibility: {
		check: unreachable,
		request: unreachable,
	},
	microphone: {
		check: unreachable,
		request: unreachable,
	},
} as unknown as typeof import('./index.tauri').PermissionsServiceLive;
