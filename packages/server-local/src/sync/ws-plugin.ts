import {
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
} from '@epicenter/sync-core';
import type { RoomManagerConfig } from './rooms';
import { createRoomManager } from './rooms';
import { Elysia, t } from 'elysia';

/** Interval between server-initiated ping frames (ms). Detects dead clients. */
const PING_INTERVAL_MS = 30_000;

export type WsSyncPluginConfig = RoomManagerConfig & {
	/** Verify a token. Omit for open mode (no auth). */
	verifyToken?: (token: string) => boolean | Promise<boolean>;
};

/** Per-connection state: sync-core state + adapter-specific fields. */
type ElysiaConnectionState = {
	syncState: ConnectionState;
	roomId: string;
	sendPing: () => void;
	pingInterval: ReturnType<typeof setInterval> | null;
	pongReceived: boolean;
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
	const roomManager = createRoomManager(config);

	const connectionState = new WeakMap<object, ElysiaConnectionState>();

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

				// Join the room to get doc + awareness
				const room = roomManager.join(roomId, rawWs, (data) =>
					ws.sendBinary(data),
				);
				if (!room) {
					console.log(`[Sync] Room not found: ${roomId}`);
					ws.close(4004, `Room not found: ${roomId}`);
					return;
				}

				const { initialMessages, state: syncState } = handleWsOpen(
					room.doc,
					room.awareness,
					rawWs,
					(data: Uint8Array) => ws.sendBinary(data),
				);

				// Defer initial sync to next tick to ensure WebSocket is fully ready
				queueMicrotask(() => {
					for (const msg of initialMessages) {
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
					roomId,
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
						state.roomId,
						result.broadcast,
						ws.raw,
					);
			},

			close(ws) {
				const state = connectionState.get(ws.raw);
				if (!state) return;

				console.log(
					`[Sync] Client disconnected from room: ${state.roomId}`,
				);

				// Clean up ping/pong keepalive
				if (state.pingInterval) {
					clearInterval(state.pingInterval);
				}

				// Delegate protocol cleanup to sync-core
				handleWsClose(state.syncState);

				// Leave the room (triggers eviction timer if last connection)
				roomManager.leave(state.roomId, ws.raw);

				// Clean up Elysia-specific state
				connectionState.delete(ws.raw);
			},
		});
}
