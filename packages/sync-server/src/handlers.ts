/**
 * Framework-Agnostic Sync Handlers
 *
 * Pure functions that implement the sync protocol logic without any framework
 * coupling. Adapters (Hono/Bun, Cloudflare Durable Objects, etc.) call these
 * handlers and map the results to their transport layer.
 *
 * Pattern: bytes in → bytes out + side effects described by return values.
 * The adapter is responsible for actually sending bytes and managing connections.
 */

import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import {
	type Awareness,
	applyAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';

// ============================================================================
// Types
// ============================================================================

/**
 * Stable identity token for a WebSocket connection, used for origin-based
 * echo prevention (`===` comparison). Pass the raw WebSocket instance —
 * e.g. `ws.raw` (Bun) or the server-side `WebSocket` from a `WebSocketPair`
 * (Cloudflare). Any object works; only reference identity matters.
 */
export type ConnectionId = object;

/** Result of handling a WS open event. */
export type WsOpenResult = {
	initialMessages: Uint8Array[];
	state: ConnectionState;
};

/** Result of handling a single WS message. */
export type WsMessageResult = {
	/** Message to send back to the sender (e.g., SyncStep2 response, SYNC_STATUS echo). */
	response?: Uint8Array;
	/** Message to broadcast to all OTHER connections in the room. */
	broadcast?: Uint8Array;
};

/**
 * Per-connection state that the adapter must store.
 *
 * Pass this object to `handleWsMessage` and `handleWsClose` — they use it
 * to look up internal event handlers via a WeakMap. The adapter may read
 * `controlledClientIds` (e.g. for Cloudflare hibernation serialization)
 * but should not need to touch internal handler functions.
 */
export type ConnectionState = {
	doc: Y.Doc;
	awareness: Awareness;
	controlledClientIds: Set<number>;
	connId: ConnectionId;
};

/** Internal event handlers, hidden from consumers. */
type ConnectionInternals = {
	updateHandler: (update: Uint8Array, origin: unknown) => void;
	awarenessHandler: (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => void;
};

/**
 * Internal handler storage. Keyed on the ConnectionState object itself,
 * so cleanup in handleWsClose can retrieve the handlers without exposing
 * them in the public type.
 */
const connectionInternals = new WeakMap<ConnectionState, ConnectionInternals>();

// ============================================================================
// WebSocket Handlers
// ============================================================================

/**
 * Handle a new WebSocket connection opening.
 *
 * The adapter calls this when a WebSocket connects. It returns:
 * - Messages to send to the client (sync step 1 + awareness states)
 * - A ConnectionState the adapter must store for the connection's lifetime
 *
 * The adapter is responsible for:
 * - Resolving the doc/awareness for the room (via RoomManager, DO instance, etc.)
 * - Sending the initialMessages to the client
 * - Storing the ConnectionState (keyed however makes sense for the framework)
 *
 * Registers two event handlers (cleaned up by handleWsClose):
 * - doc.on('updateV2') — forwards V2 updates to this connection
 * - awareness.on('update') — tracks which awareness client IDs this connection controls
 */
export function handleWsOpen(
	doc: Y.Doc,
	awareness: Awareness,
	connId: ConnectionId,
	send: (data: Uint8Array) => void,
): WsOpenResult {
	const controlledClientIds = new Set<number>();

	// Build initial messages
	const initialMessages: Uint8Array[] = [encodeSyncStep1({ doc })];
	const awarenessStates = awareness.getStates();
	if (awarenessStates.size > 0) {
		initialMessages.push(
			encodeAwarenessStates({
				awareness,
				clients: Array.from(awarenessStates.keys()),
			}),
		);
	}

	// Forward V2 doc updates to this connection (cleaned up by handleWsClose)
	const updateHandler = (update: Uint8Array, origin: unknown) => {
		if (origin === connId) return; // Don't echo back to sender
		send(encodeSyncUpdate({ update }));
	};
	doc.on('updateV2', updateHandler);

	// Track which awareness client IDs this connection controls, using
	// the Awareness class's own event rather than manually parsing bytes.
	// The origin parameter from applyAwarenessUpdate lets us attribute
	// changes to the correct connection.
	const awarenessHandler = (
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin !== connId) return;
		for (const id of added) controlledClientIds.add(id);
		for (const id of updated) controlledClientIds.add(id);
		for (const id of removed) controlledClientIds.delete(id);
	};
	awareness.on('update', awarenessHandler);

	const state: ConnectionState = {
		doc,
		awareness,
		controlledClientIds,
		connId,
	};

	connectionInternals.set(state, { updateHandler, awarenessHandler });

	return { initialMessages, state };
}

/**
 * Handle an incoming WebSocket binary message.
 *
 * Pure dispatch on MESSAGE_TYPE. Returns what the adapter should send/broadcast.
 * The adapter is responsible for actually sending the bytes.
 */
export function handleWsMessage(
	data: Uint8Array,
	state: ConnectionState,
): WsMessageResult {
	const decoder = decoding.createDecoder(data);
	const messageType = decoding.readVarUint(decoder);

	switch (messageType) {
		case MESSAGE_TYPE.SYNC: {
			const syncType = decoding.readVarUint(decoder);
			const payload = decoding.readVarUint8Array(decoder);
			const response = handleSyncPayload({
				syncType: syncType as SyncMessageType,
				payload,
				doc: state.doc,
				origin: state.connId,
			});
			return response ? { response } : {};
		}

		case MESSAGE_TYPE.AWARENESS: {
			const update = decoding.readVarUint8Array(decoder);
			applyAwarenessUpdate(state.awareness, update, state.connId);
			const broadcast = encodeAwareness({ update });
			return { broadcast };
		}

		case MESSAGE_TYPE.QUERY_AWARENESS: {
			const awarenessStates = state.awareness.getStates();
			if (awarenessStates.size > 0) {
				return {
					response: encodeAwarenessStates({
						awareness: state.awareness,
						clients: Array.from(awarenessStates.keys()),
					}),
				};
			}
			return {};
		}

		case MESSAGE_TYPE.SYNC_STATUS: {
			const payload = decoding.readVarUint8Array(decoder);
			return { response: encodeSyncStatus({ payload }) };
		}

		default:
			// Forward-compatible: unknown message types are silently ignored.
			// Yjs clients/servers routinely encounter extension types (e.g.
			// SYNC_STATUS=102) they don't understand — silent drop is correct.
			return {};
	}
}

/**
 * Handle a WebSocket connection closing.
 *
 * Performs protocol-level cleanup: unregisters event handlers and
 * removes awareness states for this connection's controlled client IDs.
 *
 * The adapter is responsible for cleaning up any framework-specific state
 * (ping intervals, WeakMap entries, room manager leave, etc.).
 */
export function handleWsClose(state: ConnectionState): void {
	const internals = connectionInternals.get(state);
	if (internals) {
		state.doc.off('updateV2', internals.updateHandler);
		state.awareness.off('update', internals.awarenessHandler);
		connectionInternals.delete(state);
	}

	if (state.controlledClientIds.size > 0) {
		removeAwarenessStates(
			state.awareness,
			Array.from(state.controlledClientIds),
			null,
		);
	}
}
