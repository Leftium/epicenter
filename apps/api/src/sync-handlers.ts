/**
 * Yjs sync + awareness protocol handlers, tailored for Cloudflare Durable
 * Objects.
 *
 * Inlined from the generic @epicenter/sync-server package. Narrowed to CF
 * WebSocket types: no framework-agnostic indirection, no WeakMap tricks.
 *
 * ## API surface
 *
 * {@link registerConnection}: side-effectful, registers doc update listener.
 * {@link applyMessage}: mutates doc / awareness, returns additional effects.
 *
 * ## Wire surfaces
 *
 * Three binary message types ride this WebSocket:
 *
 *   SYNC      (0): standard y-protocols document sync.
 *   AWARENESS (1): standard y-protocols awareness updates. Used to
 *                  publish per-peer `liveness.installationId`. The relay
 *                  validates the `liveness` sub-field on every inbound
 *                  update and discards entries that try to claim a
 *                  different installationId than the URL-stamped value.
 *   AUTH      (2): reserved sentinel; no frames are exchanged.
 *
 * Dispatch (`dispatch_inbound` / `dispatch_response`) rides on WebSocket
 * *text* frames and is handled outside this module.
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
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok, trySync } from 'wellcrafted/result';
import {
	type Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from 'y-protocols/awareness';
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

/** Shared room state for every connection in a room. */
export type RoomContext = {
	doc: Y.Doc;
	awareness: Awareness;
};

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
 * `learnedClientIDs` rides on `broadcast` effects from AWARENESS frames:
 * it tells the DO which Yjs `clientID`s just published valid `liveness`,
 * so the WS attachment can be amended for force-clear on close. SYNC
 * frames never set it (SYNC broadcasts happen via the doc-update
 * listener inside {@link registerConnection}, not via this return).
 *
 * `applyMessage` returns `Result<MessageEffect | null>`: `null` means
 * valid message with no further effect (AUTH, dropped awareness entries,
 * STEP2/UPDATE, unknown types).
 */
export type MessageEffect =
	| { action: 'reply'; data: Uint8Array }
	| {
			action: 'broadcast';
			data: Uint8Array;
			learnedClientIDs?: number[];
	  };

// ============================================================================
// Awareness encoding helpers
// ============================================================================

/**
 * Filter an inbound awareness update so only entries whose
 * `state.liveness.installationId` matches the connection's URL-stamped
 * value survive. Entries with no `liveness` sub-field pass through
 * untouched; entries with a mismatching `liveness.installationId` are
 * dropped (the spec calls this "drop the update silently" per client).
 *
 * Returns:
 *   - `filtered`: re-encoded awareness update with only the surviving
 *     entries (null if all entries were dropped).
 *   - `clientIDs`: the Yjs client ids that survived. The caller uses these
 *     to record `clientID` into the WS attachment for force-clear on close.
 */
export function filterAwarenessUpdate({
	update,
	expectedInstallationId,
}: {
	update: Uint8Array;
	expectedInstallationId: string;
}): { filtered: Uint8Array | null; clientIDs: number[] } {
	const decoder = decoding.createDecoder(update);
	const len = decoding.readVarUint(decoder);
	const kept: Array<{ clientID: number; clock: number; stateJson: string }> =
		[];
	const clientIDs: number[] = [];
	for (let i = 0; i < len; i++) {
		const clientID = decoding.readVarUint(decoder);
		const clock = decoding.readVarUint(decoder);
		const stateJson = decoding.readVarString(decoder);
		// Parse only to inspect liveness; we keep the original JSON string for
		// re-encoding to preserve byte-exact non-liveness sub-fields.
		const state = JSON.parse(stateJson) as {
			liveness?: { installationId?: unknown };
		} | null;
		if (state && state.liveness) {
			const claimed = state.liveness.installationId;
			if (typeof claimed !== 'string' || claimed !== expectedInstallationId) {
				// Drop this client's entry silently. No close, no error frame.
				continue;
			}
		}
		kept.push({ clientID, clock, stateJson });
		clientIDs.push(clientID);
	}
	if (kept.length === 0) {
		return { filtered: null, clientIDs };
	}
	const filtered = encoding.encode((enc) => {
		encoding.writeVarUint(enc, kept.length);
		for (const k of kept) {
			encoding.writeVarUint(enc, k.clientID);
			encoding.writeVarUint(enc, k.clock);
			encoding.writeVarString(enc, k.stateJson);
		}
	});
	return { filtered, clientIDs };
}

/**
 * Wrap a raw awareness update payload in the top-level AWARENESS frame
 * suitable for sending on the wire:
 *
 *   [varUint MESSAGE_TYPE.AWARENESS][varUint8Array awarenessUpdate]
 *
 * This matches the y-websocket convention used by every y-protocols
 * implementation.
 */
export function encodeAwarenessFrame(awarenessUpdate: Uint8Array): Uint8Array {
	return encoding.encode((enc) => {
		encoding.writeVarUint(enc, MESSAGE_TYPE.AWARENESS);
		encoding.writeVarUint8Array(enc, awarenessUpdate);
	});
}

/**
 * Encode the current awareness state for a set of client ids as a full
 * AWARENESS broadcast frame. Used on hibernation wake to restore peers'
 * view of liveness.
 */
export function encodeAwarenessFrameForClients(
	awareness: Awareness,
	clientIDs: number[],
): Uint8Array {
	return encodeAwarenessFrame(encodeAwarenessUpdate(awareness, clientIDs));
}

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
 * Mutates `room.doc` and/or `room.awareness` as appropriate, then returns
 * `Result<MessageEffect | null>`. `null` is the "valid, no further work"
 * outcome: STEP2/UPDATE applied to the doc (broadcast happens inside the
 * doc-update listener registered by {@link registerConnection}), AWARENESS
 * with every entry rejected, AUTH, unknown message types.
 *
 * `Err(SyncHandlerError.MessageDecode)` covers lib0 buffer underflow on
 * truncated input.
 */
export function applyMessage({
	data,
	room,
	connection,
}: {
	data: Uint8Array;
	room: RoomContext;
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
						doc: room.doc,
						origin: connection.ws,
					});
					return response ? { action: 'reply', data: response } : null;
				}

				case MESSAGE_TYPE.AWARENESS: {
					const payload = decoding.readVarUint8Array(decoder);
					const { filtered, clientIDs } = filterAwarenessUpdate({
						update: payload,
						expectedInstallationId: connection.installationId,
					});
					if (!filtered) return null;
					// Mutate the shared Awareness so the relay's view stays in sync;
					// peers receive the filtered update via the broadcast frame.
					applyAwarenessUpdate(room.awareness, filtered, connection.ws);
					return {
						action: 'broadcast',
						data: encodeAwarenessFrame(filtered),
						learnedClientIDs: clientIDs,
					};
				}

				case MESSAGE_TYPE.AUTH: {
					// Auth is handled at the Worker boundary (Better Auth middleware).
					// Receiving AUTH on an already-authenticated WS is unexpected:
					// log for observability but don't close the connection.
					console.warn(
						'[sync] Unexpected AUTH message on authenticated WebSocket',
					);
					return null;
				}

				default:
					console.warn(`[sync] Unknown WS message type: ${messageType}`);
					return null;
			}
		},
		catch: (cause) => SyncHandlerError.MessageDecode({ cause }),
	});
}
