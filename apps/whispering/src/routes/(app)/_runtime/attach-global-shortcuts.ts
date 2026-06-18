import { shortcuts } from '#platform/shortcuts';
import { tauri } from '#platform/tauri';

export function attachGlobalShortcuts() {
	// `sync` registers the current bindings. On desktop that registers the Tier-0
	// chords on the plugin, whose own callbacks dispatch into the command layer,
	// so there is no separate listener to start: registration is the
	// subscription. The browser backend's `sync` binds in-app keydown the same
	// way. Teardown unregisters the plugin chords (a no-op on the browser).
	void shortcuts.sync();

	return () => {
		void tauri?.globalShortcuts.unregisterChords();
	};
}
