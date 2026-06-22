import { tauri } from '#platform/tauri';
import { shortcuts } from '$lib/platform/shortcuts';

/**
 * Register the current shortcut bindings on every backend this build runs.
 * `shortcuts.sync()` is the reach router's sync, so it pushes both halves: the
 * focused bindings into the in-app keydown matcher (on every platform, which is
 * what makes in-app shortcuts work on desktop) and, on desktop, the global
 * bindings onto the plugin (Tier-0 chords, whose own callbacks dispatch into the
 * command layer) and the rdev tap (Tier-1 Fn/modifier-only holds). On web the
 * router has no system backend, so only the focused matcher is pushed. Cleanup
 * unregisters the desktop plugin chords. The in-app keydown listener and the
 * tap's trigger channel are each owned by their own runtime owner
 * (`attachLocalShortcutListener`, `attachGlobalShortcutTriggers`).
 */
export function attachShortcutSync() {
	void shortcuts.sync();
	return () => {
		void tauri?.keyboard.unregisterChords();
	};
}
