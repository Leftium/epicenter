/**
 * Web stub for a Tauri-only service. See `index.tauri.ts`.
 */

function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}

export const AutostartError = {
	CheckFailed: unreachable,
	EnableFailed: unreachable,
	DisableFailed: unreachable,
} as unknown as typeof import('./index.tauri').AutostartError;

export const AutostartServiceLive = {
	isEnabled: unreachable,
	enable: unreachable,
	disable: unreachable,
} as unknown as typeof import('./index.tauri').AutostartServiceLive;
