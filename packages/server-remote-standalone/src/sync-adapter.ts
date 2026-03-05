import type { SharedEnv } from '@epicenter/server-remote';
import {
	type ConnectionState,
	createRoomManager,
	handleHttpGetDoc,
	handleHttpSync,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	type UpdateLog,
} from '@epicenter/sync-core';
import type { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';

const { upgradeWebSocket, websocket } = createBunWebSocket();

export { websocket };

type SyncAdapterConfig = {
	/** Sync hooks. */
	onRoomCreated?: (roomId: string) => void;
	onRoomEvicted?: (roomId: string) => void;
	/** Eviction timeout in ms. Default: 60_000. */
	evictionTimeout?: number;
};

/**
 * Mount WebSocket and HTTP sync routes on a Hono app.
 *
 * Adds:
 * - `GET /rooms/:room` — WebSocket upgrade
 * - `POST /rooms/:room` — HTTP sync (push + pull)
 * - `GET /rooms/:room/doc` — HTTP full doc fetch
 */
export function mountSyncRoutes(
	app: Hono<SharedEnv>,
	config?: SyncAdapterConfig,
) {
	const roomManager = createRoomManager({
		evictionTimeout: config?.evictionTimeout,
		onRoomCreated: config?.onRoomCreated
			? (roomId) => config.onRoomCreated!(roomId)
			: undefined,
		onRoomEvicted: config?.onRoomEvicted
			? (roomId) => config.onRoomEvicted!(roomId)
			: undefined,
	});

	// Ephemeral — standalone hub doesn't persist sync data.
	// HTTP sync routes use this no-op storage so the interface is satisfied.
	const storage = {
		async append() {},
		async readAll() {
			return [];
		},
		async replaceAll() {},
	} satisfies UpdateLog;

	// Ping/pong keepalive — track intervals per connection via WeakMap on ws.raw
	const pingIntervals = new WeakMap<object, ReturnType<typeof setInterval>>();

	// Per-connection state keyed by ws.raw (stable identity)
	const connectionStates = new WeakMap<object, ConnectionState>();

	// --- WebSocket upgrade route ---
	app.get(
		'/rooms/:room',
		upgradeWebSocket((c) => {
			const roomId = c.req.param('room')!;

			return {
				onOpen(_evt, ws) {
					const raw = ws.raw!;

					const send = (data: Uint8Array) => {
						ws.send(data as Uint8Array<ArrayBuffer>);
					};

					const result = handleWsOpen(roomManager, roomId, raw, send);
					if (!result.ok) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(ws.close as any)(result.closeCode, result.closeReason);
						return;
					}

					// Register the update handler on the doc
					result.state.doc.on('update', result.state.updateHandler);
					connectionStates.set(raw, result.state);

					// Send initial messages
					for (const msg of result.initialMessages) {
						ws.send(msg as Uint8Array<ArrayBuffer>);
					}

					// Start ping/pong keepalive
					const interval = setInterval(() => {
						try {
							(raw as { ping?(): void }).ping?.();
						} catch {
							// Connection may have closed
						}
					}, 30_000);
					pingIntervals.set(raw, interval);
				},

				onMessage(evt, ws) {
					const raw = ws.raw!;
					const state = connectionStates.get(raw);
					if (!state) return;

					const data = new Uint8Array(evt.data as ArrayBuffer);
					const messageResult = handleWsMessage(data, state);

					if (messageResult.response) {
						ws.send(messageResult.response as Uint8Array<ArrayBuffer>);
					}
					if (messageResult.broadcast) {
						roomManager.broadcast(state.roomId, messageResult.broadcast, raw);
					}
				},

				onClose(_evt, ws) {
					const raw = ws.raw!;
					const state = connectionStates.get(raw);
					if (!state) return;

					// Clear ping interval
					const interval = pingIntervals.get(raw);
					if (interval) {
						clearInterval(interval);
					}

					handleWsClose(state, roomManager);
				},

				onError(_evt, ws) {
					const raw = ws.raw!;
					const state = connectionStates.get(raw);
					if (!state) return;

					const interval = pingIntervals.get(raw);
					if (interval) {
						clearInterval(interval);
					}

					handleWsClose(state, roomManager);
				},
			};
		}),
	);

	// --- HTTP sync routes ---
	app.post('/rooms/:room', async (c) => {
		const roomId = c.req.param('room');
		const body = new Uint8Array(await c.req.arrayBuffer());
		const result = await handleHttpSync(storage, roomId, body);
		if (result.status === 304) return c.body(null, 304);
		return c.body(result.body as Uint8Array<ArrayBuffer>, 200, {
			'Content-Type': 'application/octet-stream',
		});
	});

	app.get('/rooms/:room/doc', async (c) => {
		const roomId = c.req.param('room');
		const result = await handleHttpGetDoc(storage, roomId);
		if (result.status === 404) return c.body(null, 404);
		return c.body(result.body as Uint8Array<ArrayBuffer>, 200, {
			'Content-Type': 'application/octet-stream',
		});
	});

	return { roomManager };
}
