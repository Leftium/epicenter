import {
	type ConnectionState,
	createRoomManager,
	decodeSyncRequest,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	stateVectorsEqual,
} from '@epicenter/sync-core';
import type { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import * as Y from 'yjs';
import type { UpdateLog } from './storage';

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
	doc.on('updateV2', async (update: Uint8Array) => {
		try {
			await storage.append(roomId, update);
		} catch (err) {
			console.error(`[sync] Failed to persist update for room ${roomId}:`, err);
		}
	});

	return doc;
}

/** Per-connection state: sync-core state + adapter-specific fields. */
type AdapterConnectionState = {
	syncState: ConnectionState;
	roomId: string;
};

/**
 * Mount WebSocket and HTTP sync routes on a Hono app.
 *
 * Adds:
 * - `GET /rooms/:room` — WebSocket upgrade
 * - `POST /rooms/:room` — HTTP sync (push + pull)
 * - `GET /rooms/:room/doc` — HTTP full doc fetch
 */
// biome-ignore lint/suspicious/noExplicitAny: Env shape is defined by the caller
export function mountSyncRoutes(app: Hono<any>, config: SyncAdapterConfig) {
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
	const connectionStates = new WeakMap<object, AdapterConnectionState>();

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

					// Join the room to get doc + awareness
					const room = roomManager.join(roomId, raw, (data) => {
						ws.send(data as Uint8Array<ArrayBuffer>);
					});
					if (!room) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(ws.close as any)(4004, `Room not found: ${roomId}`);
						return;
					}

					const { initialMessages, state } = handleWsOpen(
						room.doc,
						room.awareness,
						raw,
						(data) => ws.send(data as Uint8Array<ArrayBuffer>),
					);

					connectionStates.set(raw, { syncState: state, roomId });

					// Send initial messages
					for (const msg of initialMessages) {
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
					const conn = connectionStates.get(raw);
					if (!conn) return;

					const data = new Uint8Array(evt.data as ArrayBuffer);
					const messageResult = handleWsMessage(data, conn.syncState);

					if (messageResult.response) {
						ws.send(messageResult.response as Uint8Array<ArrayBuffer>);
					}
					if (messageResult.broadcast) {
						roomManager.broadcast(conn.roomId, messageResult.broadcast, raw);
					}
				},

				onClose(_evt, ws) {
					const raw = ws.raw!;
					const conn = connectionStates.get(raw);
					if (!conn) return;

					// Clear ping interval
					const interval = pingIntervals.get(raw);
					if (interval) {
						clearInterval(interval);
					}

					handleWsClose(conn.syncState);
					roomManager.leave(conn.roomId, raw);
					connectionStates.delete(raw);
				},

				onError(_evt, ws) {
					const raw = ws.raw!;
					const conn = connectionStates.get(raw);
					if (!conn) return;

					const interval = pingIntervals.get(raw);
					if (interval) {
						clearInterval(interval);
					}

					handleWsClose(conn.syncState);
					roomManager.leave(conn.roomId, raw);
					connectionStates.delete(raw);
				},
			};
		}),
	);

	// --- HTTP sync routes ---
	app.post('/rooms/:room', async (c) => {
		const roomId = c.req.param('room');
		const body = new Uint8Array(await c.req.arrayBuffer());

		const { stateVector: clientSV, update } = decodeSyncRequest(body);

		if (update.byteLength > 0) {
			await storage.append(roomId, update);
		}

		const updates = await storage.readAll(roomId);
		if (updates.length === 0) {
			return c.body(null, 304);
		}

		const merged = Y.mergeUpdatesV2(updates);
		const serverSV = Y.encodeStateVectorFromUpdateV2(merged);

		if (stateVectorsEqual(serverSV, clientSV)) {
			return c.body(null, 304);
		}

		const diff = Y.diffUpdateV2(merged, clientSV);
		return c.body(diff as Uint8Array<ArrayBuffer>, 200, {
			'Content-Type': 'application/octet-stream',
		});
	});

	app.get('/rooms/:room/doc', async (c) => {
		const roomId = c.req.param('room');
		const updates = await storage.readAll(roomId);
		if (updates.length === 0) {
			return c.body(null, 404);
		}

		const merged = Y.mergeUpdatesV2(updates);
		return c.body(merged as Uint8Array<ArrayBuffer>, 200, {
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
