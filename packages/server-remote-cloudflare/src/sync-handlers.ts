/**
 * Yjs sync protocol handlers, tailored for Cloudflare Durable Objects.
 *
 * Inlined from the generic @epicenter/sync-server package. Narrowed to CF
 * WebSocket types — no framework-agnostic indirection, no WeakMap tricks.
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
} from '@epicenter/sync';

export { Awareness } from 'y-protocols/awareness';

// ============================================================================
// Types
// ============================================================================

/** Per-connection state stored in `Map<WebSocket, ConnectionState>`. */
export type ConnectionState = {
	ws: WebSocket;
	doc: Y.Doc;
	awareness: Awareness;
	controlledClientIds: Set<number>;
	/** Stored directly — no WeakMap indirection needed when we own the type. */
	updateHandler: (update: Uint8Array, origin: unknown) => void;
	awarenessHandler: (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => void;
};

/** Result of handling a single WS message. */
export type WsMessageResult = {
	/** Message to send back to the sender. */
	response?: Uint8Array;
	/** Message to broadcast to all OTHER connections. */
	broadcast?: Uint8Array;
};

// ============================================================================
// Handlers
// ============================================================================

/**
 * Initialize a new WebSocket connection's sync state.
 *
 * Returns initial messages to send (SyncStep1 + awareness) and the
 * ConnectionState the caller must store for the connection's lifetime.
 *
 * Registers `doc.on('updateV2')` and `awareness.on('update')` handlers
 * that are cleaned up by {@link handleWsClose}.
 */
export function handleWsOpen(
	doc: Y.Doc,
	awareness: Awareness,
	ws: WebSocket,
): { initialMessages: Uint8Array[]; state: ConnectionState } {
	const controlledClientIds = new Set<number>();

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

	// Forward V2 doc updates to this connection (skip echo via identity check)
	const updateHandler = (update: Uint8Array, origin: unknown) => {
		if (origin === ws) return;
		try {
			ws.send(encodeSyncUpdate({ update }));
		} catch {
			/* connection already dead */
		}
	};
	doc.on('updateV2', updateHandler);

	// Track which awareness client IDs this connection controls
	const awarenessHandler = (
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin !== ws) return;
		for (const id of added) controlledClientIds.add(id);
		for (const id of updated) controlledClientIds.add(id);
		for (const id of removed) controlledClientIds.delete(id);
	};
	awareness.on('update', awarenessHandler);

	const state: ConnectionState = {
		ws,
		doc,
		awareness,
		controlledClientIds,
		updateHandler,
		awarenessHandler,
	};

	return { initialMessages, state };
}

/**
 * Dispatch an incoming binary WebSocket message.
 *
 * Returns what the caller should send back / broadcast. The caller is
 * responsible for actually sending the bytes.
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
				origin: state.ws,
			});
			return response ? { response } : {};
		}

		case MESSAGE_TYPE.AWARENESS: {
			const update = decoding.readVarUint8Array(decoder);
			applyAwarenessUpdate(state.awareness, update, state.ws);
			return { broadcast: encodeAwareness({ update }) };
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
 * Clean up a closed WebSocket connection.
 *
 * Unregisters event handlers and removes awareness states for this
 * connection's controlled client IDs.
 */
export function handleWsClose(state: ConnectionState): void {
	state.doc.off('updateV2', state.updateHandler);
	state.awareness.off('update', state.awarenessHandler);

	if (state.controlledClientIds.size > 0) {
		removeAwarenessStates(
			state.awareness,
			Array.from(state.controlledClientIds),
			null,
		);
	}
}
