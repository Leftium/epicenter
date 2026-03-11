/**
 * Yjs sync protocol handlers, tailored for Cloudflare Durable Objects.
 *
 * Inlined from the generic @epicenter/sync-server package. Narrowed to CF
 * WebSocket types — no framework-agnostic indirection, no WeakMap tricks.
 *
 * ## Error handling rationale (grounded in Yjs internals)
 *
 * `Y.applyUpdateV2` is resilient by design — it never throws on malformed
 * data. Missing dependencies are stored in `doc.store.pendingStructs` and
 * automatically retried when future updates arrive.
 *
 * However, `lib0/decoding` functions (readVarUint, readVarUint8Array) DO
 * throw on buffer underflow, and `applyAwarenessUpdate` from y-protocols
 * throws on malformed JSON. Since WebSocket messages are untrusted input,
 * `handleWsMessage` wraps the decode+dispatch path with `trySync` to catch
 * these at the system boundary.
 */

import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, trySync } from 'wellcrafted/result';
import {
	type Awareness,
	applyAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';

export { Awareness } from 'y-protocols/awareness';

// ============================================================================
// Errors
// ============================================================================

/**
 * Errors from the sync handler layer.
 *
 * `MessageDecode` covers all failures when processing untrusted WebSocket
 * binary frames: lib0 buffer underflow (truncated messages), y-protocols
 * awareness JSON parse errors, and any other decode-time exceptions.
 */
export const SyncHandlerError = defineErrors({
	MessageDecode: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode WebSocket message: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SyncHandlerError = InferErrors<typeof SyncHandlerError>;

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

// ============================================================================
// Broadcast Helpers
// ============================================================================

/** Silently ignore errors (e.g. dead WebSocket sends/closes). */
export function swallow(fn: () => void): void {
	try {
		fn();
	} catch {
		/* connection already dead */
	}
}

/**
 * Broadcast a message to all connections except the sender.
 *
 * Each `send()` is wrapped individually so a dead socket can't abort
 * the loop — remaining connections still receive the message.
 */
export function safeBroadcast(
	connectionStates: Map<WebSocket, ConnectionState>,
	sender: WebSocket,
	msg: Uint8Array,
): void {
	for (const [ws] of connectionStates) {
		if (ws !== sender && ws.readyState === WebSocket.OPEN) {
			swallow(() => ws.send(msg));
		}
	}
}

/**
 * Typed effect produced by {@link handleWsMessage}.
 *
 * The handler returns an array of effects. The DO processes each one in
 * order. This makes adding new message types impossible to silently miss —
 * every handler path must produce explicit effects.
 *
 * - `respond`: Send data back to the sender only.
 * - `broadcast`: Fan out data to all OTHER connections (exclude sender).
 * - `persistAttachment`: Save connection metadata to survive hibernation.
 */
export type SyncEffect =
	| { type: 'respond'; data: Uint8Array }
	| { type: 'broadcast'; data: Uint8Array }
	| { type: 'persistAttachment' };

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
		trySync({
			try: () => ws.send(encodeSyncUpdate({ update })),
			catch: () => Ok(undefined), // connection already dead
		});
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
 * Returns a `Result` — `Ok` with a list of {@link SyncEffect}s the caller
 * must process in order, or `Err(SyncHandlerError.MessageDecode)` if the
 * binary frame is malformed.
 *
 * The `trySync` wrapper catches lib0 decoder throws (buffer underflow on
 * truncated messages) and y-protocols awareness errors (malformed JSON).
 * Yjs's own `applyUpdateV2` is resilient and won't throw — it stores
 * unresolved dependencies in `doc.store.pendingStructs` automatically.
 */
export function handleWsMessage(data: Uint8Array, state: ConnectionState) {
	return trySync({
		try: (): SyncEffect[] => {
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
						origin: state.ws,
					});
					return response ? [{ type: 'respond', data: response }] : [];
				}

				case MESSAGE_TYPE.AWARENESS: {
					const update = decoding.readVarUint8Array(decoder);
					applyAwarenessUpdate(state.awareness, update, state.ws);
					return [
						{ type: 'broadcast', data: encodeAwareness({ update }) },
						{ type: 'persistAttachment' },
					];
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					const awarenessStates = state.awareness.getStates();
					if (awarenessStates.size > 0) {
						return [
							{
								type: 'respond',
								data: encodeAwarenessStates({
									awareness: state.awareness,
									clients: Array.from(awarenessStates.keys()),
								}),
							},
						];
					}
					return [];
				}

				case MESSAGE_TYPE.SYNC_STATUS: {
					// Echo the raw message back unchanged — zero parsing cost.
					// Client uses this for sync confirmation ("Saving…" → "Saved")
					// and dead connection detection (2s probe + 3s timeout).
					return [{ type: 'respond', data }];
				}

				case MESSAGE_TYPE.AUTH: {
					// Auth is handled at the Worker boundary (Better Auth middleware).
					// Receiving AUTH on an already-authenticated WS is unexpected —
					// log for observability but don't close the connection.
					console.warn(
						'[sync] Unexpected AUTH message on authenticated WebSocket',
					);
					return [];
				}

				default:
					console.warn(`[sync] Unknown WS message type: ${messageType}`);
					return [];
			}
		},
		catch: (cause) => SyncHandlerError.MessageDecode({ cause }),
	});
}

/**
 * Clean up a closed WebSocket connection.
 *
 * Unregisters event handlers and removes awareness states for this
 * connection's controlled client IDs. The `removeAwarenessStates` call
 * is wrapped in `trySync` as a safety net — awareness cleanup should
 * never prevent handler deregistration from completing.
 */
export function handleWsClose(state: ConnectionState): void {
	state.doc.off('updateV2', state.updateHandler);
	state.awareness.off('update', state.awarenessHandler);

	if (state.controlledClientIds.size > 0) {
		trySync({
			try: () =>
				removeAwarenessStates(
					state.awareness,
					Array.from(state.controlledClientIds),
					null,
				),
			catch: () => Ok(undefined), // cleanup best-effort
		});
	}
}
