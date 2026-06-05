/**
 * Owner-scoped synced construction for Whispering.
 *
 * Two pure-ish building blocks the boot selector (`openActiveWhispering`)
 * composes when signed in:
 *
 *  - `buildSignedIn(auth)` projects the current auth state into the `SignedIn`
 *    payload every workspace opener consumes. This is the same projection
 *    `createSession` does internally; we inline it on purpose, because
 *    `createSession`'s live reactive swap fights reload-on-auth (see the
 *    spec's decision 2.3).
 *  - `wireSynced(ydoc, ...)` connects the root doc to local storage and the
 *    relay via the shared `connectDoc` primitive. It mirrors what every app's
 *    `browser.ts`/`connect()` ultimately calls; Whispering has no child docs,
 *    so this is the only call it needs.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import type { SignedIn } from '@epicenter/svelte/auth';
import {
	type ActionRegistry,
	connectDoc,
	type NodeId,
} from '@epicenter/workspace';
import type * as Y from 'yjs';

/**
 * Project the current (non-signed-out) `auth.state` into a `SignedIn` payload.
 *
 * `server`/`baseURL` are constant across auth states (one API per client), so
 * they are read once. Throws if called while signed-out: callers branch on
 * `auth.state.status` first.
 */
export function buildSignedIn(auth: SyncAuthClient): SignedIn {
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

/**
 * Connect the root doc to local IndexedDB persistence and the relay room for
 * its guid, via the shared `connectDoc` primitive.
 */
export function wireSynced(
	ydoc: Y.Doc,
	{
		signedIn,
		nodeId,
		actions,
	}: { signedIn: SignedIn; nodeId: NodeId; actions: ActionRegistry },
) {
	return connectDoc(ydoc, { ...signedIn, nodeId }, { actions });
}
