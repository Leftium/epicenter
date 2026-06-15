/**
 * Zhongwen browser composition.
 *
 * Single source of truth for "how Zhongwen mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (tables + KV via createZhongwen)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. runtime storage + sync around the per-conversation transcript child docs
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener. The bundle's `wipe()` drops every
 * owner-scoped IDB database; `Symbol.dispose` tears down the root
 * + cached child Y.Docs without touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte/auth';
import {
	attachLocalStorage,
	createChildDocs,
	type DeviceId,
	defineWorkspaceBundle,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { attachChatTranscript } from '@epicenter/workspace/ai';
import { createZhongwen } from './zhongwen';

/**
 * Open Zhongwen in the browser with local storage, cloud sync, and the
 * per-conversation transcript doc cache.
 */
export function openZhongwenBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createZhongwen();

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
	});
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: workspace.ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions: workspace.actions,
	});

	// Per-conversation transcript child docs: the bound runtime owns lifecycle
	// (refcount + grace) and connection (local storage + cloud sync, the latter
	// being what lets the server generation actor stream assistant tokens into
	// the doc and every signed-in device watch them live). `attachChatTranscript`
	// owns the transcript shape and the client writer policy. Keyed by guid; the
	// consumer derives it from the conversation id via `zhongwenConversationDocGuid`.
	const conversationDocs = createChildDocs({ ...signedIn, deviceId })(
		attachChatTranscript,
	);

	let docsTornDown = false;

	function teardownDocs() {
		if (docsTornDown) return;
		docsTornDown = true;
		conversationDocs[Symbol.dispose]();
		workspace[Symbol.dispose]();
	}

	return defineWorkspaceBundle({
		...workspace,
		idb,
		conversationDocs,
		collaboration,
		async wipe() {
			teardownDocs();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
		[Symbol.dispose]() {
			teardownDocs();
		},
	});
}
