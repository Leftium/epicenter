import { Elysia } from 'elysia';
import * as decoding from 'lib0/decoding';
import { Ok, trySync } from 'wellcrafted/result';
import * as awarenessProtocol from 'y-protocols/awareness';
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

/** WebSocket close code for room not found (4000-4999 reserved for application use per RFC 6455) */
const CLOSE_ROOM_NOT_FOUND = 4004;

/** Interval between server-initiated ping frames (ms). Detects dead clients (laptop lid closed, browser killed). */
const PING_INTERVAL_MS = 30_000;

/** Time (ms) to wait after the last connection leaves a room before destroying it. */
const ROOM_EVICTION_TIMEOUT_MS = 60_000;

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

type SyncPluginConfig = {
	/** Get Y.Doc for a workspace. Called when client connects. */
	getDoc: (workspaceId: string) => Y.Doc | undefined;
};

/**
 * Creates an Elysia plugin that provides y-websocket compatible sync.
 *
 * This implements the y-websocket server protocol:
 * - messageSync (0): Document synchronization via y-protocols/sync
 * - messageAwareness (1): User presence via y-protocols/awareness
 * - messageQueryAwareness (3): Request current awareness states
 *
 * Uses Elysia's native WebSocket which leverages Bun's efficient implementation.
 *
 * @example
 * ```typescript
 * const app = new Elysia()
 *   .use(createSyncPlugin({
 *     getDoc: (workspaceId) => workspaces.get(workspaceId)?.ydoc,
 *   }))
 *   .listen(3913);
 *
 * // Clients connect to: ws://localhost:3913/workspaces/blog/sync
 * ```
 */
export function createSyncPlugin(config: SyncPluginConfig) {
	/**
	 * Track connections per room for broadcasting.
	 * Uses minimal interface (just `send`) to avoid coupling to complex Elysia WebSocket type.
	 */
	const rooms = new Map<string, Set<{ send: (data: Buffer) => void }>>();

	/** Track awareness (user presence) per room. */
	const awarenessMap = new Map<string, awarenessProtocol.Awareness>();

	/** Track pending eviction timers per room. Cancelled if a new connection joins before expiry. */
	const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Store per-connection state using the underlying raw WebSocket as key.
	 *
	 * IMPORTANT: Elysia creates a new wrapper object for each event (open, message, close),
	 * so `ws` objects are NOT identity-stable across handlers. However, `ws.raw` (the underlying
	 * Bun ServerWebSocket) IS stable. We use `ws.raw` as the WeakMap key for consistent lookups.
	 *
	 * WeakMap ensures automatic cleanup when connections close (no memory leaks).
	 */
	const connectionState = new WeakMap<
		object,
		{
			/** The room this connection belongs to. */
			room: string;
			/** The Yjs document being synced. */
			doc: Y.Doc;
			/** Awareness instance for user presence in this room. */
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

	/** Get or create awareness instance for a room. Awareness is lazily created on first connection. */
	const getAwareness = ({
		room,
		doc,
	}: {
		room: string;
		doc: Y.Doc;
	}): awarenessProtocol.Awareness => {
		if (!awarenessMap.has(room)) {
			awarenessMap.set(room, new awarenessProtocol.Awareness(doc));
		}
		// biome-ignore lint/style/noNonNullAssertion: Value guaranteed to exist from above .has() check
		return awarenessMap.get(room)!;
	};

	return new Elysia().ws('/workspaces/:workspaceId/sync', {
		open(ws) {
			const room = ws.data.params.workspaceId;
			console.log(`[Sync Server] Client connected to room: ${room}`);
			const doc = config.getDoc(room);

			if (!doc) {
				console.log(`[Sync Server] Room not found: ${room}`);
				ws.close(CLOSE_ROOM_NOT_FOUND, `Room not found: ${room}`);
				return;
			}

			// Use ws.raw as stable key - Elysia creates new wrapper objects per event
			const rawWs = ws.raw;

			// Cancel pending eviction timer if a new connection joins the room
			const existingTimer = evictionTimers.get(room);
			if (existingTimer) {
				clearTimeout(existingTimer);
				evictionTimers.delete(room);
				console.log(`[Sync Server] Cancelled eviction timer for room: ${room}`);
			}

			// Track connection
			if (!rooms.has(room)) {
				rooms.set(room, new Set());
			}
			// biome-ignore lint/style/noNonNullAssertion: Value guaranteed to exist from above .has() check
			rooms.get(room)!.add(ws);

			// Track which client IDs this connection controls (for cleanup on disconnect)
			const controlledClientIds = new Set<number>();

			// Get awareness for this room
			const awareness = getAwareness({ room, doc });

			// Defer send to next tick to ensure WebSocket is fully ready
			queueMicrotask(() => {
				// Send initial sync step 1
				ws.send(toBuffer(encodeSyncStep1({ doc })));

				// Send current awareness states
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
				// Use rawWs for origin comparison since that's what we pass as origin
				if (origin === rawWs) return; // Don't echo back
				ws.send(toBuffer(encodeSyncUpdate({ update })));
			};
			doc.on('update', updateHandler);

			// Start server-side ping/pong keepalive to detect dead clients.
			// If a pong wasn't received since the last ping, the client is dead.
			const pongReceived = true;
			const pingInterval = setInterval(() => {
				const state = connectionState.get(rawWs);
				if (!state) return;

				if (!state.pongReceived) {
					// No pong since last ping — client is dead
					console.log(
						`[Sync Server] No pong received, closing dead connection in room: ${room}`,
					);
					ws.close();
					return;
				}

				// Reset pong flag and send ping
				state.pongReceived = false;
				// Bun's ServerWebSocket supports ping() on the raw socket
				(rawWs as { ping?: () => void }).ping?.();
			}, PING_INTERVAL_MS);

			// Store connection state using ws.raw as key for consistent lookup
			connectionState.set(rawWs, {
				room,
				doc,
				awareness,
				updateHandler,
				controlledClientIds,
				rawWs,
				pingInterval,
				pongReceived,
			});
		},

		pong(ws) {
			// Pong received from client in response to our ping.
			// Mark this connection as alive so the next ping check doesn't close it.
			const state = connectionState.get(ws.raw);
			if (state) {
				state.pongReceived = true;
			}
		},

		message(ws, message) {
			// Use ws.raw for state lookup - wrapper objects differ per event
			const state = connectionState.get(ws.raw);
			if (!state) return;

			const { room, doc, awareness, controlledClientIds, rawWs } = state;

			const data =
				message instanceof ArrayBuffer
					? new Uint8Array(message)
					: (message as Uint8Array);
			const decoder = decoding.createDecoder(data);
			const messageType = decoding.readVarUint(decoder);

			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					// Pass rawWs as origin to match the updateHandler's comparison
					const response = handleSyncMessage({ decoder, doc, origin: rawWs });
					if (response) {
						ws.send(toBuffer(response));
					}
					break;
				}

				case MESSAGE_TYPE.AWARENESS: {
					const update = decoding.readVarUint8Array(decoder);

					// Decode the update to track which client IDs this connection controls.
					// The update contains [clientID, clock, state?] entries.
					// Use trySync because malformed messages shouldn't crash the connection.
					trySync({
						try: () => {
							const decoder2 = decoding.createDecoder(update);
							const len = decoding.readVarUint(decoder2);
							for (let i = 0; i < len; i++) {
								const clientId = decoding.readVarUint(decoder2);
								decoding.readVarUint(decoder2); // clock
								const state = JSON.parse(decoding.readVarString(decoder2));
								if (state === null) {
									// Client is removing their awareness state
									controlledClientIds.delete(clientId);
								} else {
									// Client is setting their awareness state
									controlledClientIds.add(clientId);
								}
							}
						},
						catch: () => {
							// Malformed awareness update - skip client ID tracking but still apply
							return Ok(undefined);
						},
					});

					awarenessProtocol.applyAwarenessUpdate(awareness, update, rawWs);

					// Broadcast awareness to other clients in the room
					const conns = rooms.get(room);
					if (conns) {
						const awarenessMessage = toBuffer(encodeAwareness({ update }));
						for (const conn of conns) {
							if (conn !== ws) {
								conn.send(awarenessMessage);
							}
						}
					}
					break;
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					// Client is requesting current awareness states
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
					// Echo the payload back unchanged — that's it.
					// The client uses this to track hasLocalChanges and heartbeat.
					const payload = decoding.readVarUint8Array(decoder);
					ws.send(toBuffer(encodeSyncStatus({ payload })));
					break;
				}
			}
		},

		close(ws) {
			// Use ws.raw for state lookup - wrapper objects differ per event
			const state = connectionState.get(ws.raw);
			if (!state) return;

			const {
				room,
				doc,
				updateHandler,
				awareness,
				controlledClientIds,
				pingInterval,
			} = state;

			console.log(`[Sync Server] Client disconnected from room: ${room}`);

			// Clean up ping/pong keepalive interval
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

			// Remove from room (use ws wrapper since that's what we added in open)
			rooms.get(room)?.delete(ws);
			if (rooms.get(room)?.size === 0) {
				// Last connection left — start eviction timer instead of immediately destroying
				console.log(
					`[Sync Server] Room ${room} is empty, starting ${ROOM_EVICTION_TIMEOUT_MS / 1000}s eviction timer`,
				);
				const timer = setTimeout(() => {
					// Verify the room is still empty (a new connection could have cancelled this)
					const conns = rooms.get(room);
					if (!conns || conns.size === 0) {
						rooms.delete(room);
						awarenessMap.delete(room);
						evictionTimers.delete(room);
						console.log(`[Sync Server] Evicted idle room: ${room}`);
					}
				}, ROOM_EVICTION_TIMEOUT_MS);
				evictionTimers.set(room, timer);
			}

			// Clean up connection state using raw key
			connectionState.delete(ws.raw);
		},
	});
}
