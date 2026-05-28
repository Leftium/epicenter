/**
 * Shared composition for the Whispering runtime client.
 *
 * Builds the workspace bundle, attaches IndexedDB persistence and same-device
 * broadcast sync, and exposes the `whenReady` handle. Platform-specific entry
 * points (`whispering.browser.ts`, `whispering.tauri.ts`) layer their own
 * `recordings_export_markdown` action on top.
 *
 * Lives as a plain `.ts` (no `.browser`/`.tauri` suffix) so both build targets
 * reuse the same composition without one platform importing the other's
 * singleton. Importing this file does not attach anything on its own.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/workspace';
import { createWhisperingWorkspace } from '$lib/workspace';

export function openWhisperingBase() {
	const workspace = createWhisperingWorkspace();

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	return { workspace, whenReady: idb.whenLoaded };
}
