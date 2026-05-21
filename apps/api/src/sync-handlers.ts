/**
 * Yjs sync protocol handlers, tailored for Cloudflare Durable Objects.
 *
 * Inlined from the generic @epicenter/sync-server package. Narrowed to CF
 * WebSocket types: no framework-agnostic indirection, no WeakMap tricks.
 *
 * ## API surface
 *
 * {@link registerConnection}: side-effectful, registers doc update listener.
 * {@link applyMessage}: mutates doc, returns additional effects.
 *
 * ## Wire surfaces
 *
 * Binary frames handled here carry standard y-protocols document sync
 * (`MESSAGE_TYPE.SYNC`). AWARENESS frames are no longer consumed (presence
 * is server-owned and rides text frames); the slot stays reserved in
 * `@epicenter/sync` for future cursor/typing/selection work, but the DO
 * does not route it. AUTH is reserved as a sentinel close path and never
 * appears on the wire today.
 *
 * Dispatch (`dispatch_inbound` / `dispatch_response`) and presence
 * (`presence_snapshot` / `presence_added` / `presence_removed`) ride on
 * WebSocket *text* frames and are handled outside this module.
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
	MESSAGE_TYPE,
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

/**
 * Result of handling a single WebSocket message.
 *
 * Discriminated union on `action`. Each variant maps to one routing pattern
 * in the DO caller:
 *
 *   `reply`:     Send data back to the sender only.
 *   `broadcast`: Fan out to all other connections.
 *
 * `applyMessage` returns `Result<MessageEffect | null>`: `null` means
 * valid message with no further effect (STEP2/UPDATE, unknown types).
 */
export type MessageEffect =
	| { action: 'reply'; data: Uint8Array }
	| { action: 'broadcast'; data: Uint8Array };

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
 * Mutates `doc` as appropriate, then returns `Result<MessageEffect | null>`.
 * `null` is the "valid, no further work" outcome: STEP2/UPDATE applied to
 * the doc (broadcast happens inside the doc-update listener registered by
 * {@link registerConnection}), unknown message types.
 *
 * `Err(SyncHandlerError.MessageDecode)` covers lib0 buffer underflow on
 * truncated input.
 */
export function applyMessage({
	data,
	doc,
	connection,
}: {
	data: Uint8Array;
	doc: Y.Doc;
	connection: Connection;
}) {
	return trySync({
		try: (): MessageEffect | null => {
			const decoder = decoding.createDecoder(data);
			const messageType = decoding.readVarUint(decoder);

			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					const syncType = decoding.readVarUint(decoder) as SyncMessageType;
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType,
						payload,
						doc,
						origin: connection.ws,
					});
					return response ? { action: 'reply', data: response } : null;
				}

				default:
					console.warn(`[sync] Unknown WS message type: ${messageType}`);
					return null;
			}
		},
		catch: (cause) => SyncHandlerError.MessageDecode({ cause }),
	});
}
