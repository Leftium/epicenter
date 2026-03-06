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
import * as Y from 'yjs';
import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncMessage,
	MESSAGE_TYPE,
} from './protocol';
import type { createRoomManager } from './rooms';
import {
	decodeSyncRequest,
	stateVectorsEqual,
	type UpdateLog,
} from './storage';

// ============================================================================
// Types
// ============================================================================

/** Opaque connection identity. Elysia uses ws.raw, CF uses WebSocket instance. */
export type ConnectionId = object;

/** Result of handling a WS open event. */
export type WsOpenResult =
	| {
			ok: true;
			initialMessages: Uint8Array[];
			doc: Y.Doc;
			awareness: Awareness;
			state: ConnectionState;
	  }
	| { ok: false; closeCode: number; closeReason: string };

/** Result of handling a single WS message. */
export type WsMessageResult = {
	/** Message to send back to the sender (e.g., SyncStep2 response, SYNC_STATUS echo). */
	response?: Uint8Array;
	/** Message to broadcast to all OTHER connections in the room. */
	broadcast?: Uint8Array;
};

/** Per-connection state that the adapter must store. */
export type ConnectionState = {
	roomId: string;
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
 * - Sending the initialMessages to the client
 * - Registering doc.on('update', state.updateHandler)
 * - Storing the ConnectionState (keyed however makes sense for the framework)
 */
export function handleWsOpen(
	roomManager: ReturnType<typeof createRoomManager>,
	roomId: string,
	connId: ConnectionId,
	send: (data: Uint8Array) => void,
): WsOpenResult {
	const result = roomManager.join(roomId, connId, send);
	if (!result) {
		return {
			ok: false,
			closeCode: 4004,
			closeReason: `Room not found: ${roomId}`,
		};
	}

	const { doc, awareness } = result;
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

	// Create update handler (adapter registers this on doc.on('update'))
	const updateHandler = (update: Uint8Array, origin: unknown) => {
		if (origin === connId) return; // Don't echo back to sender
		send(encodeSyncUpdate({ update }));
	};

	const state: ConnectionState = {
		roomId,
		doc,
		awareness,
		updateHandler,
		controlledClientIds,
		connId,
	};

	return { ok: true, initialMessages, doc, awareness, state };
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
 * The adapter calls this during its close handler.
 * The adapter is responsible for cleaning up any framework-specific state
 * (ping intervals, WeakMap entries, etc.) before or after calling this.
 */
export function handleWsClose(
	state: ConnectionState,
	roomManager: ReturnType<typeof createRoomManager>,
): void {
	state.doc.off('update', state.updateHandler);

	if (state.controlledClientIds.size > 0) {
		removeAwarenessStates(
			state.awareness,
			Array.from(state.controlledClientIds),
			null,
		);
	}

	roomManager.leave(state.roomId, state.connId);
}

// ============================================================================
// HTTP Sync Handler
// ============================================================================

/**
 * Handle an HTTP sync request (POST /:room).
 *
 * Stateless — no Y.Doc instantiated. Works with raw UpdateLog.
 * Returns a result the adapter maps to an HTTP response.
 */
export async function handleHttpSync(
	storage: UpdateLog,
	roomId: string,
	body: Uint8Array,
): Promise<{ status: 200 | 304; body?: Uint8Array }> {
	const { stateVector: clientSV, update } = decodeSyncRequest(body);

	if (update.byteLength > 0) {
		await storage.append(roomId, update);
	}

	const updates = await storage.readAll(roomId);
	if (updates.length === 0) {
		return { status: 304 };
	}

	const merged = Y.mergeUpdatesV2(updates);
	const serverSV = Y.encodeStateVectorFromUpdateV2(merged);

	if (stateVectorsEqual(serverSV, clientSV)) {
		return { status: 304 };
	}

	const diff = Y.diffUpdateV2(merged, clientSV);
	return { status: 200, body: diff };
}

/**
 * Handle an HTTP full document fetch (GET /:room).
 *
 * Stateless — reads all updates from storage, merges them, returns the result.
 */
export async function handleHttpGetDoc(
	storage: UpdateLog,
	roomId: string,
): Promise<{ status: 200 | 404; body?: Uint8Array }> {
	const updates = await storage.readAll(roomId);
	if (updates.length === 0) {
		return { status: 404 };
	}

	const merged = Y.mergeUpdatesV2(updates);
	return { status: 200, body: merged };
}
