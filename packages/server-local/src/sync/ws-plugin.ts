import {
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
} from '@epicenter/sync-server';
import { Hono } from 'hono';
import { websocket as bunWebsocketHandler, upgradeWebSocket } from 'hono/bun';
import type { RoomManagerConfig } from './rooms';
import { createRoomManager } from './rooms';

/** Interval between server-initiated ping frames (ms). Detects dead clients. */
const PING_INTERVAL_MS = 30_000;

export type WsSyncPluginConfig = RoomManagerConfig & {
	/** Verify a token. Omit for open mode (no auth). */
	verifyToken?: (token: string) => boolean | Promise<boolean>;
};

/** Per-connection state: sync-core state + adapter-specific fields. */
type SyncConnectionState = {
	syncState: ConnectionState;
	roomId: string;
	pingInterval: ReturnType<typeof setInterval> | null;
	pongReceived: boolean;
};

/**
 * Creates a Hono sub-app and Bun websocket handler for Y.Doc sync over WebSocket.
 *
 * Returns `{ syncApp, websocket }`:
 * - `syncApp` is mounted at `/rooms` by the sidecar
 * - `websocket` must be passed to `Bun.serve({ websocket })` for WS support
 */
export function createWsSyncPlugin(config?: WsSyncPluginConfig) {
	const roomManager = createRoomManager(config);
	const connectionState = new WeakMap<object, SyncConnectionState>();
	const verifyToken = config?.verifyToken;

	const app = new Hono();

	app.get('/', (c) => c.json({ rooms: roomManager.roomInfo() }));

	app.get(
		'/:room',
		upgradeWebSocket((c) => {
			const roomId = c.req.param('room')!;
			const token = c.req.query('token');

			return {
				async onOpen(_evt, ws) {
					// Auth check
					if (verifyToken) {
						if (!token || !(await verifyToken(token))) {
							ws.close(4001, 'Unauthorized');
							return;
						}
					}

					const rawWs = ws.raw!;
					const send = (data: Uint8Array) =>
						ws.send(data as Uint8Array<ArrayBuffer>);

					console.log(`[Sync] Client connected to room: ${roomId}`);

					const room = roomManager.join(roomId, rawWs, send);
					if (!room) {
						console.log(`[Sync] Room not found: ${roomId}`);
						ws.close(4004, `Room not found: ${roomId}`);
						return;
					}

					const { initialMessages, state: syncState } = handleWsOpen(
						room.doc,
						room.awareness,
						rawWs,
						send,
					);

					// Defer initial sync to next tick to ensure WebSocket is fully ready
					queueMicrotask(() => {
						for (const msg of initialMessages) {
							send(msg);
						}
					});

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
						// biome-ignore lint/suspicious/noExplicitAny: access raw Bun ServerWebSocket ping
						(rawWs as any).ping();
					}, PING_INTERVAL_MS);

					connectionState.set(rawWs, {
						syncState,
						roomId,
						pingInterval,
						pongReceived: true,
					});
				},

				onMessage(evt, ws) {
					const rawWs = ws.raw!;
					const state = connectionState.get(rawWs);
					if (!state) return;

					const message = evt.data;
					if (
						!(message instanceof ArrayBuffer) &&
						!(message instanceof Uint8Array)
					)
						return;
					const data =
						message instanceof ArrayBuffer ? new Uint8Array(message) : message;

					const result = handleWsMessage(data, state.syncState);

					if (result.response)
						ws.send(result.response as Uint8Array<ArrayBuffer>);
					if (result.broadcast)
						roomManager.broadcast(state.roomId, result.broadcast, rawWs);
				},

				onClose(_evt, ws) {
					const rawWs = ws.raw!;
					const state = connectionState.get(rawWs);
					if (!state) return;

					console.log(`[Sync] Client disconnected from room: ${state.roomId}`);

					if (state.pingInterval) {
						clearInterval(state.pingInterval);
					}

					handleWsClose(state.syncState);
					roomManager.leave(state.roomId, rawWs);
					connectionState.delete(rawWs);
				},
			};
		}),
	);

	// Extend Hono's websocket handler with pong support for keepalive
	const extendedWebsocket = {
		...bunWebsocketHandler,
		// biome-ignore lint/suspicious/noExplicitAny: Bun websocket handler type
		pong(ws: any) {
			const state = connectionState.get(ws.raw ?? ws);
			if (state) {
				state.pongReceived = true;
			}
		},
	};

	return { syncApp: app, websocket: extendedWebsocket };
}
