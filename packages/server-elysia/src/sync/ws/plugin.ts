import {
	type ConnectionState,
	createRoomManager,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
} from '@epicenter/sync-core';
import { Elysia, t } from 'elysia';
import type * as Y from 'yjs';

/** Interval between server-initiated ping frames (ms). Detects dead clients. */
const PING_INTERVAL_MS = 30_000;

export type WsSyncPluginConfig = {
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
 * Creates an Elysia plugin that provides Y.Doc synchronization over WebSocket.
 *
 * Thin wrapper around `@epicenter/sync-core` handlers. All protocol logic
 * is delegated to sync-core; this plugin handles Elysia-specific concerns:
 * - WeakMap keyed on `ws.raw` (stable Bun ServerWebSocket reference)
 * - Ping/pong keepalive
 * - `queueMicrotask` for deferred initial send (Elysia WS readiness)
 */
export function createWsSyncPlugin(config?: WsSyncPluginConfig) {
	const roomManager = createRoomManager({
		getDoc: config?.getDoc,
		onRoomCreated: config?.onRoomCreated,
		onRoomEvicted: config?.onRoomEvicted,
	});

	/** Elysia-specific per-connection state (ping/pong + sync-core state). */
	const connectionState = new WeakMap<
		object,
		{
			syncState: ConnectionState;
			sendPing: () => void;
			pingInterval: ReturnType<typeof setInterval> | null;
			pongReceived: boolean;
		}
	>();

	const verifyToken = config?.verifyToken;

	return new Elysia()
		.get('/', () => ({ rooms: roomManager.roomInfo() }))
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

				const rawWs = ws.raw;

				const result = handleWsOpen(
					roomManager,
					roomId,
					rawWs,
					(data: Uint8Array) => ws.sendBinary(data),
				);

				if (!result.ok) {
					console.log(`[Sync] Room not found: ${roomId}`);
					ws.close(result.closeCode, result.closeReason);
					return;
				}

				const { state: syncState } = result;

				// Register update handler on doc
				syncState.doc.on('update', syncState.updateHandler);

				// Defer initial sync to next tick to ensure WebSocket is fully ready
				queueMicrotask(() => {
					for (const msg of result.initialMessages) {
						ws.sendBinary(msg);
					}
				});

				// Capture typed ping from ws.raw (stable reference)
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
					syncState,
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

				// Binary protocol — narrow the message to Uint8Array
				if (
					!(message instanceof ArrayBuffer) &&
					!(message instanceof Uint8Array)
				)
					return;
				const data =
					message instanceof ArrayBuffer ? new Uint8Array(message) : message;

				const result = handleWsMessage(data, state.syncState);

				if (result.response) ws.sendBinary(result.response);
				if (result.broadcast)
					roomManager.broadcast(
						state.syncState.roomId,
						result.broadcast,
						ws.raw,
					);
			},

			close(ws) {
				const state = connectionState.get(ws.raw);
				if (!state) return;

				console.log(
					`[Sync] Client disconnected from room: ${state.syncState.roomId}`,
				);

				// Clean up ping/pong keepalive
				if (state.pingInterval) {
					clearInterval(state.pingInterval);
				}

				// Delegate protocol cleanup to sync-core
				handleWsClose(state.syncState, roomManager);

				// Clean up Elysia-specific state
				connectionState.delete(ws.raw);
			},
		});
}
