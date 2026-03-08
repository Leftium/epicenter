/**
 * Framework-Agnostic Sync Handlers
 *
 * Pure functions that implement the sync protocol logic without any framework
 * coupling. Adapters (Elysia, Hono, Cloudflare Workers, etc.) call these
 * handlers and map the results to their transport layer.
 *
 * Pattern: bytes in → bytes out + side effects described by return values.
 * The adapter is responsible for actually sending bytes and managing connections.
 */

import * as decoding from 'lib0/decoding';
import {
	type Awareness,
	applyAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';
import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncMessage,
	MESSAGE_TYPE,
} from './protocol';

// ============================================================================
// Types
// ============================================================================

/** Opaque connection identity. Elysia uses ws.raw, CF uses WebSocket instance. */
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

/** Per-connection state that the adapter must store. */
export type ConnectionState = {
	doc: Y.Doc;
	awareness: Awareness;
	updateHandler: (update: Uint8Array, origin: unknown) => void;
	controlledClientIds: Set<number>;
	connId: ConnectionId;
};

// ============================================================================
// WebSocket Handlers
// ============================================================================

/**
 * Handle a new WebSocket connection opening.
 *
 * The adapter calls this when a WebSocket connects. It returns:
 * - Messages to send to the client (sync step 1 + awareness states)
 * - A ConnectionState the adapter must store for the connection's lifetime
 * - An updateHandler that the adapter must register on doc.on('update')
 *
 * The adapter is responsible for:
 * - Resolving the doc/awareness for the room (via RoomManager, DO instance, etc.)
 * - Sending the initialMessages to the client
 * - Storing the ConnectionState (keyed however makes sense for the framework)
 *
 * The update handler is registered automatically on doc.on('update') and
 * cleaned up by handleWsClose.
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

	// Create and register update handler (cleaned up by handleWsClose)
	const updateHandler = (update: Uint8Array, origin: unknown) => {
		if (origin === connId) return; // Don't echo back to sender
		send(encodeSyncUpdate({ update }));
	};
	doc.on('update', updateHandler);

	const state: ConnectionState = {
		doc,
		awareness,
		updateHandler,
		controlledClientIds,
		connId,
	};

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
			const response = handleSyncMessage({
				decoder,
				doc: state.doc,
				origin: state.connId,
			});
			return response ? { response } : {};
		}

		case MESSAGE_TYPE.AWARENESS: {
			const update = decoding.readVarUint8Array(decoder);

			// Track controlled client IDs (best-effort, errors swallowed)
			try {
				const decoder2 = decoding.createDecoder(update);
				const len = decoding.readVarUint(decoder2);
				for (let i = 0; i < len; i++) {
					const clientId = decoding.readVarUint(decoder2);
					decoding.readVarUint(decoder2); // clock
					const awarenessState = JSON.parse(decoding.readVarString(decoder2));
					if (awarenessState === null) {
						state.controlledClientIds.delete(clientId);
					} else {
						state.controlledClientIds.add(clientId);
					}
				}
			} catch {
				/* best effort */
			}

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
			return {};
	}
}

/**
 * Handle a WebSocket connection closing.
 *
 * Performs protocol-level cleanup: unregisters the update handler and
 * removes awareness states for this connection's controlled client IDs.
 *
 * The adapter is responsible for cleaning up any framework-specific state
 * (ping intervals, WeakMap entries, room manager leave, etc.).
 */
export function handleWsClose(state: ConnectionState): void {
	state.doc.off('update', state.updateHandler);

	if (state.controlledClientIds.size > 0) {
		removeAwarenessStates(
			state.awareness,
			Array.from(state.controlledClientIds),
			null,
		);
	}
}
