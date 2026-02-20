import { Elysia } from 'elysia';
import * as decoding from 'lib0/decoding';
import { Ok, trySync } from 'wellcrafted/result';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { type AuthConfig, CLOSE_UNAUTHORIZED, validateAuth } from './auth';
import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncMessage,
	MESSAGE_TYPE,
} from './protocol';
import { createRoomManager } from './rooms';

/** WebSocket close code for room not found (4000-4999 reserved for application use per RFC 6455). */
const CLOSE_ROOM_NOT_FOUND = 4004;

/** Interval between server-initiated ping frames (ms). Detects dead clients. */
const PING_INTERVAL_MS = 30_000;

/**
 * Convert Uint8Array to Buffer for WebSocket transmission.
 *
 * Elysia's WebSocket (via Bun) serializes Uint8Array to JSON by default,
 * but sends Buffer as raw binary. This wrapper ensures protocol messages
 * are transmitted as proper binary data.
 */
function toBuffer(data: Uint8Array): Buffer {
	return Buffer.from(data);
}

export type SyncPluginConfig = {
	/**
	 * Resolve a Y.Doc for a room. Called when a client connects.
	 *
	 * - If provided and returns Y.Doc, use that doc for the room
	 * - If provided and returns undefined, close with 4004 (room not found)
	 * - If omitted, create a fresh Y.Doc on demand (standalone mode)
	 */
	getDoc?: (roomId: string) => Y.Doc | undefined;

	/** Auth configuration. Omit for open mode (no auth). */
	auth?: AuthConfig;

	/** Called when a room is created (first connection). Only fires in standalone mode (no getDoc). */
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

	/** Called when a room is evicted (60s after last connection leaves). */
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

/**
 * Creates an Elysia plugin that provides y-websocket compatible sync.
 *
 * Implements the y-websocket server protocol:
 * - messageSync (0): Document synchronization via y-protocols/sync
 * - messageAwareness (1): User presence via y-protocols/awareness
 * - messageQueryAwareness (3): Request current awareness states
 * - messageSyncStatus (102): Heartbeat echo for hasLocalChanges tracking
 *
 * Operates in two modes:
 * - **Standalone** (no `getDoc`): Creates fresh Y.Docs on demand. Rooms are ephemeral.
 * - **Integrated** (`getDoc` provided): Uses existing Y.Docs. Returns 4004 for unknown rooms.
 *
 * The plugin always registers the route `/:room/ws`. Use Elysia's native
 * `prefix` option to mount it under a different path:
 *
 * @example
 * ```typescript
 * // Standalone mode — rooms created on demand
 * // Route: /:room/ws
 * const app = new Elysia()
 *   .use(createSyncPlugin())
 *   .listen(3913);
 *
 * // Integrated mode — mount under /workspaces prefix
 * // Route: /workspaces/:room/ws
 * const app = new Elysia()
 *   .use(
 *     new Elysia({ prefix: '/workspaces' })
 *       .use(createSyncPlugin({ getDoc: (room) => workspaces[room]?.ydoc }))
 *   )
 *   .listen(3913);
 * ```
 */
export function createSyncPlugin(config?: SyncPluginConfig) {
	const roomManager = createRoomManager({
		getDoc: config?.getDoc,
		onRoomCreated: config?.onRoomCreated,
		onRoomEvicted: config?.onRoomEvicted,
	});

	/**
	 * Per-connection state keyed by ws.raw (stable Bun ServerWebSocket reference).
	 *
	 * Elysia creates a new wrapper object for each WS event (open, message, close),
	 * so `ws` objects are NOT identity-stable across handlers. `ws.raw` IS stable.
	 * WeakMap ensures automatic cleanup when connections close.
	 */
	const connectionState = new WeakMap<
		object,
		{
			roomId: string;
			doc: Y.Doc;
			awareness: awarenessProtocol.Awareness;
			/** Handler to broadcast doc updates to this client (stored for cleanup). */
			updateHandler: (update: Uint8Array, origin: unknown) => void;
			/** Client IDs this connection controls, for awareness cleanup on disconnect. */
			controlledClientIds: Set<number>;
			/** The raw WebSocket, used as origin for Yjs transactions to prevent echo. */
			rawWs: object;
			/** Interval handle for server-side ping keepalive. */
			pingInterval: ReturnType<typeof setInterval> | null;
			/** Whether a pong was received since the last ping. */
			pongReceived: boolean;
		}
	>();

	return new Elysia().ws('/:room/ws', {
		async open(ws) {
			const roomId = ws.data.params.room;

			// Auth check — extract ?token from query params
			const token =
				(ws.data.query as Record<string, string>).token ?? undefined;
			const authorized = await validateAuth(config?.auth, token);

			if (!authorized) {
				ws.close(CLOSE_UNAUTHORIZED, 'Unauthorized');
				return;
			}

			console.log(`[Sync] Client connected to room: ${roomId}`);

			// Use ws.raw as stable key — Elysia creates new wrapper objects per event
			const rawWs = ws.raw;

			// Join room via room manager (handles doc creation/resolution + eviction cancellation)
			const result = roomManager.join(roomId, rawWs, (data) => ws.send(data));
			if (!result) {
				console.log(`[Sync] Room not found: ${roomId}`);
				ws.close(CLOSE_ROOM_NOT_FOUND, `Room not found: ${roomId}`);
				return;
			}

			const { doc, awareness } = result;
			const controlledClientIds = new Set<number>();

			// Defer initial sync to next tick to ensure WebSocket is fully ready
			queueMicrotask(() => {
				ws.send(toBuffer(encodeSyncStep1({ doc })));

				const awarenessStates = awareness.getStates();
				if (awarenessStates.size > 0) {
					ws.send(
						toBuffer(
							encodeAwarenessStates({
								awareness,
								clients: Array.from(awarenessStates.keys()),
							}),
						),
					);
				}
			});

			// Listen for doc updates to broadcast to this client
			const updateHandler = (update: Uint8Array, origin: unknown) => {
				if (origin === rawWs) return; // Don't echo back to sender
				ws.send(toBuffer(encodeSyncUpdate({ update })));
			};
			doc.on('update', updateHandler);

			// Server-side ping/pong keepalive to detect dead clients
			const pingInterval = setInterval(() => {
				const state = connectionState.get(rawWs);
				if (!state) return;

				if (!state.pongReceived) {
					console.log(
						`[Sync] No pong received, closing dead connection in room: ${roomId}`,
					);
					ws.close();
					return;
				}

				state.pongReceived = false;
				(rawWs as { ping?: () => void }).ping?.();
			}, PING_INTERVAL_MS);

			connectionState.set(rawWs, {
				roomId,
				doc,
				awareness,
				updateHandler,
				controlledClientIds,
				rawWs,
				pingInterval,
				pongReceived: true,
			});
		},

		pong(ws) {
			const state = connectionState.get(ws.raw);
			if (state) {
				state.pongReceived = true;
			}
		},

		message(ws, message) {
			const state = connectionState.get(ws.raw);
			if (!state) return;

			const { roomId, doc, awareness, controlledClientIds, rawWs } = state;

			const data =
				message instanceof ArrayBuffer
					? new Uint8Array(message)
					: (message as Uint8Array);
			const decoder = decoding.createDecoder(data);
			const messageType = decoding.readVarUint(decoder);

			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					const response = handleSyncMessage({ decoder, doc, origin: rawWs });
					if (response) {
						ws.send(toBuffer(response));
					}
					break;
				}

				case MESSAGE_TYPE.AWARENESS: {
					const update = decoding.readVarUint8Array(decoder);

					// Track which client IDs this connection controls for cleanup on disconnect.
					// Use trySync because malformed messages shouldn't crash the connection.
					trySync({
						try: () => {
							const decoder2 = decoding.createDecoder(update);
							const len = decoding.readVarUint(decoder2);
							for (let i = 0; i < len; i++) {
								const clientId = decoding.readVarUint(decoder2);
								decoding.readVarUint(decoder2); // clock
								const awarenessState = JSON.parse(
									decoding.readVarString(decoder2),
								);
								if (awarenessState === null) {
									controlledClientIds.delete(clientId);
								} else {
									controlledClientIds.add(clientId);
								}
							}
						},
						catch: () => Ok(undefined),
					});

					awarenessProtocol.applyAwarenessUpdate(awareness, update, rawWs);

					// Broadcast awareness to other clients via room manager
					roomManager.broadcast(
						roomId,
						toBuffer(encodeAwareness({ update })),
						rawWs,
					);
					break;
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					const awarenessStates = awareness.getStates();
					if (awarenessStates.size > 0) {
						ws.send(
							toBuffer(
								encodeAwarenessStates({
									awareness,
									clients: Array.from(awarenessStates.keys()),
								}),
							),
						);
					}
					break;
				}

				case MESSAGE_TYPE.SYNC_STATUS: {
					// Echo the payload back unchanged — the client uses this for hasLocalChanges and heartbeat.
					const payload = decoding.readVarUint8Array(decoder);
					ws.send(toBuffer(encodeSyncStatus({ payload })));
					break;
				}
			}
		},

		close(ws) {
			const state = connectionState.get(ws.raw);
			if (!state) return;

			const {
				roomId,
				doc,
				updateHandler,
				awareness,
				controlledClientIds,
				pingInterval,
			} = state;

			console.log(`[Sync] Client disconnected from room: ${roomId}`);

			// Clean up ping/pong keepalive
			if (pingInterval) {
				clearInterval(pingInterval);
			}

			// Remove update listener
			doc.off('update', updateHandler);

			// Clean up awareness state for all client IDs this connection controlled
			if (controlledClientIds.size > 0) {
				awarenessProtocol.removeAwarenessStates(
					awareness,
					Array.from(controlledClientIds),
					null,
				);
			}

			// Remove connection from room (may start eviction timer)
			roomManager.leave(roomId, ws.raw);

			// Clean up per-connection state
			connectionState.delete(ws.raw);
		},
	});
}
