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
import { type Env } from '@epicenter/server-remote';
import type { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import * as Y from 'yjs';

const { upgradeWebSocket, websocket } = createBunWebSocket();

export { websocket };

type SyncAdapterConfig = {
	/** Persistence layer. Docs survive restarts when backed by real storage. */
	storage: UpdateLog;
	/** Sync hooks. */
	onRoomCreated?: (roomId: string) => void;
	onRoomEvicted?: (roomId: string) => void;
	/** Eviction timeout in ms. Default: 60_000. */
	evictionTimeout?: number;
};

/**
 * Load a Y.Doc from the update log, or create a fresh one if no updates exist.
 *
 * Registers a write-through listener that appends every incremental update
 * to the storage so state is never lost.
 */
async function loadOrCreateDoc(
	storage: UpdateLog,
	roomId: string,
): Promise<Y.Doc> {
	const doc = new Y.Doc();
	const updates = await storage.readAll(roomId);
	if (updates.length > 0) {
		const merged = Y.mergeUpdatesV2(updates);
		Y.applyUpdateV2(doc, merged);
	}

	// Write-through: persist every mutation.
	doc.on('updateV2', (update: Uint8Array) => {
		storage.append(roomId, update).catch((err) => {
			console.error(`[sync] Failed to persist update for room ${roomId}:`, err);
		});
	});

	return doc;
}

/**
 * Mount WebSocket and HTTP sync routes on a Hono app.
 *
 * Adds:
 * - `GET /rooms/:room` — WebSocket upgrade
 * - `POST /rooms/:room` — HTTP sync (push + pull)
 * - `GET /rooms/:room/doc` — HTTP full doc fetch
 */
export function mountSyncRoutes(
	app: Hono<Env>,
	config: SyncAdapterConfig,
) {
	const { storage } = config;

	// Cache of loaded docs keyed by roomId so multiple WS connections
	// share the same doc and the same write-through listener.
	const loadedDocs = new Map<string, Y.Doc>();

	// In-flight load promises — prevents duplicate loads when concurrent
	// WebSocket upgrades hit the same unloaded room.
	const loadingDocs = new Map<string, Promise<Y.Doc>>();

	async function getOrLoadDoc(roomId: string): Promise<Y.Doc> {
		const existing = loadedDocs.get(roomId);
		if (existing) return existing;

		const inFlight = loadingDocs.get(roomId);
		if (inFlight) return inFlight;

		const promise = loadOrCreateDoc(storage, roomId).then((doc) => {
			loadedDocs.set(roomId, doc);
			loadingDocs.delete(roomId);
			config.onRoomCreated?.(roomId);
			return doc;
		});
		loadingDocs.set(roomId, promise);
		return promise;
	}

	const roomManager = createRoomManager({
		evictionTimeout: config.evictionTimeout,

		getDoc: (roomId) => {
			// getDoc is synchronous — the upgrade handler pre-loads the doc
			// via getOrLoadDoc before onOpen fires.
			return loadedDocs.get(roomId);
		},

		onRoomEvicted: async (roomId, doc) => {
			// Compact: encode the live doc state into a single snapshot.
			const snapshot = Y.encodeStateAsUpdateV2(doc);
			await storage.replaceAll(roomId, snapshot);
			loadedDocs.delete(roomId);
			doc.destroy();
			config.onRoomEvicted?.(roomId);
		},
	});

	// Ping/pong keepalive — track intervals per connection via WeakMap on ws.raw
	const pingIntervals = new WeakMap<object, ReturnType<typeof setInterval>>();

	// Per-connection state keyed by ws.raw (stable identity)
	const connectionStates = new WeakMap<object, ConnectionState>();

	// --- WebSocket upgrade route ---
	app.get(
		'/rooms/:room',
		upgradeWebSocket((c) => {
			const roomId = c.req.param('room')!;

			// Pre-load the doc before the WS connection opens.
			const docReady = getOrLoadDoc(roomId);

			return {
				async onOpen(_evt, ws) {
					await docReady;

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

	return {
		roomManager,

		/** Compact all loaded docs before shutdown. */
		async shutdown(): Promise<void> {
			await Promise.allSettled(
				[...loadedDocs.entries()].map(async ([roomId, doc]) => {
					const snapshot = Y.encodeStateAsUpdateV2(doc);
					await storage.replaceAll(roomId, snapshot);
				}),
			);
		},
	};
}
