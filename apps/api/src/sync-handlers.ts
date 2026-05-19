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
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok, trySync } from 'wellcrafted/result';
import {
	applyAwarenessUpdate,
	type Awareness,
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

/**
 * Shared room state: the doc, awareness, and auth-derived subject that all
 * connections in a room share. The DO is user-scoped (DO name encodes the
 * owning user id), so every connection in this room carries the same
 * `subject`.
 */
export type RoomContext = {
	doc: Y.Doc;
	awareness: Awareness;
	subject: string;
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
 * `applyMessage` returns `Result<MessageResult | null>`: `null` means valid
 * message with no action needed (AUTH, dropped awareness entries, unknown
 * types).
 */
export type MessageResult =
	| { action: 'reply'; data: Uint8Array }
	| { action: 'broadcast'; data: Uint8Array };

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
		const state = JSON.parse(stateJson) as
			| { liveness?: { installationId?: unknown } }
			| null;
		if (state && state.liveness) {
			const claimed = state.liveness.installationId;
			if (
				typeof claimed !== 'string' ||
				claimed !== expectedInstallationId
			) {
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
 * Result type for awareness handling: the filtered broadcast frame (if
 * any) and the clientIDs that successfully published liveness for this
 * connection.
 */
export type AwarenessApply = {
	broadcastFrame: Uint8Array | null;
	clientIDs: number[];
};

/**
 * Dispatch an incoming binary WebSocket message.
 *
 * Mutates `room.doc` and/or `room.awareness` as appropriate, then returns
 * a `Result`. `Ok` carries one of:
 *
 *   - `{ kind: 'sync'; result: MessageResult | null }`: standard sync
 *     reply or broadcast, or null when no action is needed.
 *   - `{ kind: 'awareness'; broadcastFrame; clientIDs }`: the filtered
 *     awareness update to broadcast to other peers (null if every entry
 *     was dropped), and the surviving Yjs client ids so the caller can
 *     record them into the WS attachment.
 *   - `{ kind: 'noop' }`: AUTH or unknown message type.
 *
 * `Err(SyncHandlerError.MessageDecode)` is returned if the binary frame
 * is malformed.
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
		try: ():
			| { kind: 'sync'; result: MessageResult | null }
			| { kind: 'awareness'; apply: AwarenessApply }
			| { kind: 'noop' } => {
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
					if (response) {
						return { kind: 'sync', result: { action: 'reply', data: response } };
					}
					// STEP2 / UPDATE: applyUpdateV2 already ran inside
					// handleSyncPayload and the doc.on('updateV2') registered by
					// registerConnection broadcasts the result to other peers.
					// Acknowledge with null; the caller has nothing to send.
					if (
						syncType === SYNC_MESSAGE_TYPE.STEP2 ||
						syncType === SYNC_MESSAGE_TYPE.UPDATE
					) {
						return { kind: 'sync', result: null };
					}
					return { kind: 'sync', result: null };
				}

				case MESSAGE_TYPE.AWARENESS: {
					const payload = decoding.readVarUint8Array(decoder);
					const { filtered, clientIDs } = filterAwarenessUpdate({
						update: payload,
						expectedInstallationId: connection.installationId,
					});
					if (!filtered) {
						return {
							kind: 'awareness',
							apply: { broadcastFrame: null, clientIDs },
						};
					}
					// Mutate the shared Awareness so the relay's view stays in sync;
					// peers receive the filtered update via the broadcast frame.
					applyAwarenessUpdate(room.awareness, filtered, connection.ws);
					return {
						kind: 'awareness',
						apply: {
							broadcastFrame: encodeAwarenessFrame(filtered),
							clientIDs,
						},
					};
				}

				case MESSAGE_TYPE.AUTH: {
					// Auth is handled at the Worker boundary (Better Auth middleware).
					// Receiving AUTH on an already-authenticated WS is unexpected:
					// log for observability but don't close the connection.
					console.warn(
						'[sync] Unexpected AUTH message on authenticated WebSocket',
					);
					return { kind: 'noop' };
				}

				default:
					console.warn(`[sync] Unknown WS message type: ${messageType}`);
					return { kind: 'noop' };
			}
		},
		catch: (cause) => SyncHandlerError.MessageDecode({ cause }),
	});
}
