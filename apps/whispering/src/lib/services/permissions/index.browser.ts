/**
 * Web stub. Consumers (the macOS accessibility page, register-permissions)
 * dynamic-import this path; Vite needs the path to resolve at chunk-
 * generation time even though the call sites are unreachable on web
 * (`if (!window.__TAURI_INTERNALS__) return`).
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
