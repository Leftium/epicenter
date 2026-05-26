/**
 * Web stub. GlobalKeyboardShortcutRecorder statically imports type and
 * utilities from this path; web needs the path to resolve at chunk-
 * generation time. Call sites are gated by `window.__TAURI_INTERNALS__`
 * so the throws are unreachable on web.
 */

function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}

export const GlobalShortcutManagerLive = {
	register: unreachable,
	unregister: unreachable,
	unregisterAll: unreachable,
} as unknown as typeof import('./index.tauri').GlobalShortcutManagerLive;

export const isValidElectronAccelerator =
	unreachable as unknown as typeof import('./index.tauri').isValidElectronAccelerator;

export const pressedKeysToTauriAccelerator =
	unreachable as unknown as typeof import('./index.tauri').pressedKeysToTauriAccelerator;
