/**
 * Whispering's Tauri workspace opener.
 *
 * Conceptually this is `openWhisperingTauri()`: it creates the shared
 * `createWhisperingWorkspace()` model, then attaches Tauri-runtime resources
 * around it. The export name predates the repo-wide `open<App>Tauri` naming
 * convention.
 */

import { attachBroadcastChannel, attachIndexedDb } from '@epicenter/workspace';
import { createWhisperingWorkspace } from './index';

export function openWhispering() {
	const workspace = createWhisperingWorkspace();

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	return {
		...workspace,
		whenReady: idb.whenLoaded,
	};
}
