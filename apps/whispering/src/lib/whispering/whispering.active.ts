/**
 * Boot-time doc selection for Whispering (Option A: sync singleton + reload).
 *
 * `openActiveWhispering` reads the persisted `auth.state` ONCE at startup and
 * builds either the plaintext local doc (signed out) or the owner doc with
 * relay sync (signed in / reauth-required). Construction is synchronous; data
 * still loads async behind `whenReady`.
 *
 * It returns the raw `{ workspace, whenReady, collaboration }` so each platform
 * file can layer its one platform-specific action (`recordings_export_markdown`)
 * on top before exporting the `whispering` singleton. Identity changes are never
 * an in-place swap: `reloadOnOwnerChange` reloads the page so the next boot
 * re-runs this selection.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	createNodeId,
} from '@epicenter/workspace';
import { auth } from '#platform/auth';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createWhispering } from '$lib/workspace';
import { buildSignedIn, wireSynced } from './whispering.synced';

/**
 * Stable per-node id for relay room addressing, read synchronously from
 * `localStorage` (the async variant is only for the extension's
 * `chrome.storage`). Shared across Epicenter apps on this origin.
 */
const nodeId = createNodeId({ storage: window.localStorage });

export function openActiveWhispering(
	defaultTranscriptionService: TranscriptionServiceId,
) {
	if (auth.state.status === 'signed-out') {
		const workspace = createWhispering({ defaultTranscriptionService });
		const idb = attachIndexedDb(workspace.ydoc);
		attachBroadcastChannel(workspace.ydoc);
		return { workspace, whenReady: idb.whenLoaded, collaboration: undefined };
	}

	const signedIn = buildSignedIn(auth);
	const workspace = createWhispering({ defaultTranscriptionService });
	attachBroadcastChannel(workspace.ydoc);
	const { idb, collaboration } = wireSynced(workspace.ydoc, {
		signedIn,
		nodeId,
		actions: workspace.actions,
	});
	return { workspace, whenReady: idb.whenLoaded, collaboration };
}
