/**
 * Web stub for a Tauri-only service. See `index.tauri.ts`.
 */

function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}

export const TrayIconServiceLive = {
	setTrayIcon: unreachable,
} as unknown as typeof import('./index.tauri').TrayIconServiceLive;
