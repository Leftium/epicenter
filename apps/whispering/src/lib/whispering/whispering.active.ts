/**
 * Boot-time Whispering client for both platforms (Option A: sync singleton +
 * reload).
 *
 * `openActiveWhispering` reads the persisted `auth.state` ONCE at startup and
 * builds either the plaintext local doc (signed out) or the owner doc with
 * relay sync (signed in / reauth-required). Construction is synchronous; data
 * still loads async behind `whenReady`. Identity changes are never an
 * in-place swap: `reloadOnOwnerChange` reloads the page so the next boot
 * re-runs this selection.
 *
 * `openWhispering` wraps that doc with the one action every platform needs
 * (`recordings_export_markdown` — the logic is identical on both, see
 * `recordings-markdown-export.ts`) and exports the `satisfiesWorkspace`
 * shape. The two platform leaves (`whispering.browser.ts`,
 * `whispering.tauri.ts`) call this with only their default transcription
 * service; the `#platform/whispering` seam still needs two files so the
 * bundler picks the right one, but the two are otherwise identical.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import type { SignedIn } from '@epicenter/svelte/auth';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	connectDoc,
	createNodeId,
	defineActions,
	satisfiesWorkspace,
} from '@epicenter/workspace';
import { auth } from '#platform/auth';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createWhispering } from '$lib/workspace';
import { defineRecordingsMarkdownExport } from './recordings-markdown-export';

/**
 * Stable per-node id for relay room addressing, read synchronously from
 * `localStorage` (the async variant is only for the extension's
 * `chrome.storage`). Shared across Epicenter apps on this origin.
 */
const nodeId = createNodeId({ storage: window.localStorage });

/**
 * Project the current (non-signed-out) `auth.state` into a `SignedIn` payload
 * for `connectDoc`.
 *
 * `server`/`baseURL` are constant across auth states (one API per client), so
 * they are read once. This is the same projection `createSession` does
 * internally; we inline it on purpose, because `createSession`'s live
 * reactive swap fights reload-on-auth (see the spec's decision 2.3). Throws
 * if called while signed-out: the one caller branches on `auth.state.status`
 * first.
 */
function buildSignedIn(auth: SyncAuthClient): SignedIn {
	const baseURL = auth.baseURL;
	const server = new URL(baseURL).host;
	const state = auth.state;
	if (state.status === 'signed-out') {
		throw new Error('[whispering] buildSignedIn() called while signed-out.');
	}
	return {
		server,
		baseURL,
		ownerId: state.ownerId,
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
	};
}

function openActiveWhispering(
	defaultTranscriptionService: TranscriptionServiceId,
) {
	const workspace = createWhispering({ defaultTranscriptionService });
	attachBroadcastChannel(workspace.ydoc);

	if (auth.state.status === 'signed-out') {
		const idb = attachIndexedDb(workspace.ydoc);
		return { workspace, whenReady: idb.whenLoaded, collaboration: undefined };
	}

	const signedIn = buildSignedIn(auth);
	const { idb, collaboration } = connectDoc(
		workspace.ydoc,
		{ ...signedIn, nodeId },
		{ actions: workspace.actions },
	);
	return { workspace, whenReady: idb.whenLoaded, collaboration };
}

/** Build the `whispering` singleton: the active doc plus the shared recordings-export action. */
export function openWhispering(
	defaultTranscriptionService: TranscriptionServiceId,
) {
	const { workspace, whenReady, collaboration } = openActiveWhispering(
		defaultTranscriptionService,
	);
	return satisfiesWorkspace({
		...workspace,
		actions: defineActions({
			...workspace.actions,
			recordings_export_markdown: defineRecordingsMarkdownExport(
				workspace.tables.recordings,
			),
		}),
		whenReady,
		collaboration,
	});
}
