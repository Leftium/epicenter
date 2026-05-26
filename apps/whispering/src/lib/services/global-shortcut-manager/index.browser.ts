/**
 * Web stub. GlobalKeyboardShortcutRecorder statically imports type and
 * utilities from this path; web needs the path to resolve at chunk-
 * generation time. Call sites are gated by `window.__TAURI_INTERNALS__`
 * so the throws are unreachable on web.
 */

import { unreachable } from '$lib/services/_tauri-stub';
import type * as Tauri from './index.tauri';

export const GlobalShortcutManagerLive = {
	register: unreachable,
	unregister: unreachable,
	unregisterAll: unreachable,
} satisfies typeof Tauri.GlobalShortcutManagerLive;

export const isValidElectronAccelerator: typeof Tauri.isValidElectronAccelerator =
	unreachable;

export const pressedKeysToTauriAccelerator: typeof Tauri.pressedKeysToTauriAccelerator =
	unreachable;
