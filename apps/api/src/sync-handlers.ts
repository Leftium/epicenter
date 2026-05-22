/**
 * Yjs sync protocol handlers, tailored for Cloudflare Durable Objects.
 *
 * Concrete to CF WebSocket types: no framework-agnostic indirection, no
 * WeakMap tricks.
 *
 * ## API surface
 *
 * {@link registerConnection}: side-effectful, registers doc update listener.
 * {@link applyMessage}: mutates doc, returns the reply frame or null.
 *
 * ## Wire surfaces
 *
 * Binary frames handled here carry Yjs document sync (y-protocols/sync
 * framing: STEP1/STEP2/UPDATE). A binary frame is a sync frame; there is
 * no top-level message-type discriminator.
 *
 * Dispatch (`dispatch_inbound` / `dispatch_response`) and presence (the
 * `presence` full-list frame) ride on WebSocket *text* frames and are
 * handled outside this module.
 *
 * ## Error handling rationale (grounded in Yjs internals)
 *
 * `Y.applyUpdateV2` is resilient by design: it never throws on malformed
 * data. Missing dependencies are stored in `doc.store.pendingStructs` and
 * automatically retried when future updates arrive.
 *
 * However, `lib0/decoding` functions (readVarUint, readVarUint8Array) DO
 * throw on buffer underflow. Since WebSocket messages are untrusted input,
 * `applyMessage` wraps the decode+dispatch path with `trySync` to catch
 * these at the system boundary.
 */

import {
	handleSyncPayload,
	type SyncMessageType,
	encodeSyncUpdate,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok, trySync } from 'wellcrafted/result';
import * as Y from 'yjs';

// ============================================================================
// Errors
// ============================================================================

/**
 * Errors from the sync handler layer.
 *
 * `MessageDecode` covers all failures when processing untrusted WebSocket
 * binary frames: lib0 buffer underflow (truncated messages) and any other
 * decode-time exceptions.
 */
export const SyncHandlerError = defineErrors({
	MessageDecode: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode WebSocket message: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// ============================================================================
// Types
// ============================================================================

/**
 * Per-connection state stored in `Map<WebSocket, Connection>`.
 *
 * Contains only per-connection data: the socket, the URL-stamped
 * `installationId`, and an `unregister` closure that removes the doc update
 * listener registered by {@link registerConnection}.
 */
export type Connection = {
	ws: WebSocket;
	installationId: string;
	/** Removes the `doc.on('updateV2')` listener for this connection. */
	unregister: () => void;
};

// ============================================================================
// Connection registration
// ============================================================================

/**
 * Register a WebSocket connection's doc update listener.
 *
 * Side-effectful: registers a `doc.on('updateV2')` handler that forwards
 * updates to the WebSocket. Returns a {@link Connection} with an
 * `unregister` closure that removes the listener when the socket closes.
 */
export function registerConnection({
	doc,
	ws,
	installationId,
}: {
	doc: Y.Doc;
	ws: WebSocket;
	installationId: string;
}): Connection {
	// Forward V2 doc updates to this connection (skip echo via identity check).
	const updateHandler = (update: Uint8Array, origin: unknown) => {
		if (origin === ws) return;
		trySync({
			try: () => ws.send(encodeSyncUpdate({ update })),
			catch: () => Ok(undefined), // connection already dead
		});
	};
	doc.on('updateV2', updateHandler);

	return {
		ws,
		installationId,
		unregister() {
			doc.off('updateV2', updateHandler);
		},
	};
}

// ============================================================================
// Message dispatcher
// ============================================================================

/**
 * Dispatch an incoming binary WebSocket message.
 *
 * A binary frame is a sync frame: the first varint is the sync sub-type,
 * with no top-level message-type discriminator. Mutates `doc` as
 * appropriate, then returns `Result<Uint8Array | null>`: the STEP2 reply
 * frame for a SYNC STEP1, or `null` for the "valid, no reply" outcome
 * (STEP2/UPDATE applied to the doc, with fan-out handled inside the
 * doc-update listener registered by {@link registerConnection}).
 *
 * `Err(SyncHandlerError.MessageDecode)` covers lib0 buffer underflow on
 * truncated input.
 */
export function applyMessage({
	data,
	doc,
	ws,
}: {
	data: Uint8Array;
	doc: Y.Doc;
	ws: WebSocket;
}) {
	return trySync({
		try: (): Uint8Array | null => {
			const decoder = decoding.createDecoder(data);
			const syncType = decoding.readVarUint(decoder) as SyncMessageType;
			const payload = decoding.readVarUint8Array(decoder);
			const response = handleSyncPayload({
				syncType,
				payload,
				doc,
				origin: ws,
			});
			return response ?? null;
		},
		catch: (cause) => SyncHandlerError.MessageDecode({ cause }),
	});
}
