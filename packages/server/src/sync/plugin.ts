import { Elysia, t } from 'elysia';
import * as decoding from 'lib0/decoding';
import { Ok, trySync } from 'wellcrafted/result';
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
import { createRoomManager } from './rooms';

/**
 * Extract a Bearer token from the Authorization header.
 *
 * @returns The token string, or undefined if the header is missing or malformed.
 */
function extractBearerToken(
	authorization: string | undefined,
): string | undefined {
	if (!authorization?.startsWith('Bearer ')) return undefined;
	return authorization.slice(7);
}

/** WebSocket close code for room not found (4000-4999 reserved for application use per RFC 6455). */
const CLOSE_ROOM_NOT_FOUND = 4004;

/** Interval between server-initiated ping frames (ms). Detects dead clients. */
const PING_INTERVAL_MS = 30_000;

export type SyncPluginConfig = {
	/**
	 * Resolve a Y.Doc for a room. Called when a client connects.
	 *
	 * - If provided and returns Y.Doc, use that doc for the room
	 * - If provided and returns undefined, close with 4004 (room not found)
	 * - If omitted, create a fresh Y.Doc on demand (standalone mode)
	 */
	getDoc?: (roomId: string) => Y.Doc | undefined;

	/** Verify a token. Omit for open mode (no auth). */
	verifyToken?: (token: string) => boolean | Promise<boolean>;

	/** Called when a room is created (first connection). Only fires in standalone mode (no getDoc). */
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

	/** Called when a room is evicted (60s after last connection leaves). */
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

/**
 * Creates an Elysia plugin that provides Y.Doc synchronization over WebSocket
 * and HTTP.
 *
 * Registers four routes:
 *
 * | Method | Route    | Description                                |
 * | ------ | -------- | ------------------------------------------ |
 * | `GET`  | `/`      | List active rooms with connection counts   |
 * | `WS`   | `/:room` | Real-time y-websocket protocol             |
 * | `GET`  | `/:room` | Full document state as binary Yjs update   |
 * | `POST` | `/:room` | Apply a binary Yjs update to the document  |
 *
 * **Auth**: WebSocket uses `?token=` query param (browser WS API cannot set
 * headers). REST routes use `Authorization: Bearer` header.
 *
 * **Modes**:
 * - **Standalone** (no `getDoc`): Creates fresh Y.Docs on demand. Rooms are ephemeral.
 * - **Integrated** (`getDoc` provided): Uses existing Y.Docs. Returns 4004/404 for unknown rooms.
 *
 * Use Elysia's native `prefix` option to mount under a different path:
 *
 * @example
 * ```typescript
 * // Standalone mode — rooms created on demand
 * const app = new Elysia()
 *   .use(createSyncPlugin())
 *   .listen(3913);
 *
 * // Integrated mode — mount under /rooms prefix
 * const app = new Elysia()
 *   .use(
 *     new Elysia({ prefix: '/rooms' })
 *       .use(createSyncPlugin({ getDoc: (room) => workspaces[room]?.ydoc }))
 *   )
 *   .listen(3913);
 *
 * // REST document access
 * const state = await fetch('http://localhost:3913/rooms/my-room', {
 *   headers: { Authorization: 'Bearer my-secret' },
 * });
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
			awareness: Awareness;
			/** Handler to broadcast doc updates to this client (stored for cleanup). */
			updateHandler: (update: Uint8Array, origin: unknown) => void;
			/** Client IDs this connection controls, for awareness cleanup on disconnect. */
			controlledClientIds: Set<number>;
			/** The raw WebSocket, used as origin for Yjs transactions to prevent echo. */
			rawWs: object;
			/** Send a ping frame to detect dead clients. Captured from ws.raw.ping for proper typing. */
			sendPing: () => void;
			/** Interval handle for server-side ping keepalive. */
			pingInterval: ReturnType<typeof setInterval> | null;
			/** Whether a pong was received since the last ping. */
			pongReceived: boolean;
		}
	>();

	// ── REST routes (Bearer auth) ──────────────────────────────────────────

	const verifyToken = config?.verifyToken;

	const restAuth = new Elysia().guard({
		async beforeHandle({ headers, status }) {
			if (!verifyToken) return;
			const token = extractBearerToken(headers.authorization);
			if (!token || !(await verifyToken(token))) {
				return status('Unauthorized', 'Unauthorized');
			}
		},
	});

	return new Elysia()
		.use(
			restAuth
				.get('/', () => ({ rooms: roomManager.roomInfo() }))
				.get('/:room', ({ params, set, status }) => {
					const doc = roomManager.getDoc(params.room);
					if (!doc) {
						return status('Not Found', `Room not found: ${params.room}`);
					}
					set.headers['content-type'] = 'application/octet-stream';
					return Y.encodeStateAsUpdate(doc);
				})
				.post('/:room', async ({ params, request, status }) => {
					const doc = roomManager.getOrCreateDoc(params.room);
					if (!doc) {
						return status('Not Found', `Room not found: ${params.room}`);
					}

					const arrayBuffer = await request.arrayBuffer();
					const update = new Uint8Array(arrayBuffer);

					if (update.length === 0) {
						return status('Bad Request', 'Empty update body');
					}

					const { error } = trySync({
						try: () => {
							Y.applyUpdate(doc, update);
						},
						catch: () => Ok(undefined),
					});

					if (error) {
						return status('Bad Request', 'Invalid Yjs update');
					}

					return { ok: true };
				}),
		)
		.ws('/:room', {
			query: t.Object({
				token: t.Optional(t.String()),
			}),

			async beforeHandle({ query, status }) {
				if (!verifyToken) return;
				if (!query.token || !(await verifyToken(query.token)))
					return status(401);
			},

			async open(ws) {
				const roomId = ws.data.params.room;

				console.log(`[Sync] Client connected to room: ${roomId}`);

				// Use ws.raw as stable key — Elysia creates new wrapper objects per event
				const rawWs = ws.raw;

				// Join room via room manager (handles doc creation/resolution + eviction cancellation)
				const result = roomManager.join(roomId, rawWs, (data) =>
					ws.sendBinary(data),
				);
				if (!result) {
					console.log(`[Sync] Room not found: ${roomId}`);
					ws.close(CLOSE_ROOM_NOT_FOUND, `Room not found: ${roomId}`);
					return;
				}

				const { doc, awareness } = result;
				const controlledClientIds = new Set<number>();

				// Defer initial sync to next tick to ensure WebSocket is fully ready
				queueMicrotask(() => {
					ws.sendBinary(encodeSyncStep1({ doc }));

					const awarenessStates = awareness.getStates();
					if (awarenessStates.size > 0) {
						ws.sendBinary(
							encodeAwarenessStates({
								awareness,
								clients: Array.from(awarenessStates.keys()),
							}),
						);
					}
				});

				// Listen for doc updates to broadcast to this client
				const updateHandler = (update: Uint8Array, origin: unknown) => {
					if (origin === rawWs) return; // Don't echo back to sender
					ws.sendBinary(encodeSyncUpdate({ update }));
				};
				doc.on('update', updateHandler);

				// Capture typed ping from ws.raw (stable reference) to avoid type assertions
				const sendPing = () => ws.raw.ping();

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
					state.sendPing();
				}, PING_INTERVAL_MS);

				connectionState.set(rawWs, {
					roomId,
					doc,
					awareness,
					updateHandler,
					controlledClientIds,
					rawWs,
					sendPing,
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

				// Binary protocol — narrow the message to Uint8Array (Buffer extends Uint8Array)
				if (
					!(message instanceof ArrayBuffer) &&
					!(message instanceof Uint8Array)
				)
					return;
				const data =
					message instanceof ArrayBuffer ? new Uint8Array(message) : message;
				const decoder = decoding.createDecoder(data);
				const messageType = decoding.readVarUint(decoder);

				switch (messageType) {
					case MESSAGE_TYPE.SYNC: {
						const response = handleSyncMessage({ decoder, doc, origin: rawWs });
						if (response) {
							ws.sendBinary(response);
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

						applyAwarenessUpdate(awareness, update, rawWs);

						// Broadcast awareness to other clients via room manager
						roomManager.broadcast(roomId, encodeAwareness({ update }), rawWs);
						break;
					}

					case MESSAGE_TYPE.QUERY_AWARENESS: {
						const awarenessStates = awareness.getStates();
						if (awarenessStates.size > 0) {
							ws.sendBinary(
								encodeAwarenessStates({
									awareness,
									clients: Array.from(awarenessStates.keys()),
								}),
							);
						}
						break;
					}

					case MESSAGE_TYPE.SYNC_STATUS: {
						// Echo the payload back unchanged — the client uses this for hasLocalChanges and heartbeat.
						const payload = decoding.readVarUint8Array(decoder);
						ws.sendBinary(encodeSyncStatus({ payload }));
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
					removeAwarenessStates(
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
