import { shortcuts } from '#platform/shortcuts';
import { tauri } from '#platform/tauri';

export function attachGlobalShortcuts() {
	let cleanupShortcutListener: (() => void) | undefined;
	let shortcutListenerDestroyed = false;

	void shortcuts.sync();

	if (tauri) {
		void tauri.globalShortcuts.startListening().then((unlisten) => {
			if (shortcutListenerDestroyed) unlisten();
			else cleanupShortcutListener = unlisten;
		});
	}

	return () => {
		shortcutListenerDestroyed = true;
		cleanupShortcutListener?.();
	};
}
