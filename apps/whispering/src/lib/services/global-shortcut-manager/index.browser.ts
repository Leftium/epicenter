/**
 * Web stub for a Tauri-only service. See `index.tauri.ts`.
 *
 * The utility functions (`isValidElectronAccelerator`,
 * `pressedKeysToTauriAccelerator`) are pure in principle but
 * `pressedKeysToTauriAccelerator` calls Tauri's `os.type()` internally,
 * so we stub them too. Consumers gate on `window.__TAURI_INTERNALS__`,
 * so neither is reachable at web runtime.
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
