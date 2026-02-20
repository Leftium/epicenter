import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/** Time (ms) to wait after the last connection leaves a room before destroying it. */
const DEFAULT_EVICTION_TIMEOUT_MS = 60_000;

type Room = {
	doc: Y.Doc;
	awareness: Awareness;
	/** Connections keyed by ws.raw (stable identity). */
	conns: Map<object, { send: (data: Buffer) => void }>;
	evictionTimer?: ReturnType<typeof setTimeout>;
};

type RoomManagerConfig = {
	/**
	 * Resolve a Y.Doc for a room. Called when a client connects.
	 *
	 * - If provided and returns Y.Doc, use that doc for the room
	 * - If provided and returns undefined, room is rejected (join returns undefined)
	 * - If omitted, create a fresh Y.Doc on demand (standalone mode)
	 */
	getDoc?: (roomId: string) => Y.Doc | undefined;

	/** Time (ms) before an empty room is evicted. Default: 60_000. */
	evictionTimeout?: number;

	/** Called when a room is created (first connection). Only fires in standalone mode (no getDoc). */
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

	/** Called when a room is evicted after the eviction timer expires. */
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

/**
 * Create a room manager that tracks Y.Doc rooms, connections, and awareness.
 *
 * Fixes the ws identity bug by using `ws.raw` (stable Bun ServerWebSocket reference)
 * as the Map key instead of Elysia wrapper objects which are recreated per event.
 *
 * @example
 * ```typescript
 * const manager = createRoomManager({ evictionTimeout: 60_000 });
 *
 * // In WS open handler:
 * const result = manager.join(roomId, ws.raw, (data) => ws.send(data));
 * if (!result) { ws.close(4004); return; }
 *
 * // In WS close handler:
 * manager.leave(roomId, ws.raw);
 *
 * // Broadcasting:
 * manager.broadcast(roomId, encodedData, ws.raw);
 * ```
 */
export function createRoomManager(config?: RoomManagerConfig) {
	const rooms = new Map<string, Room>();
	const evictionTimeout =
		config?.evictionTimeout ?? DEFAULT_EVICTION_TIMEOUT_MS;

	return {
		/**
		 * Add a connection to a room. Creates the room if needed.
		 *
		 * In standalone mode (no `getDoc`), a fresh Y.Doc is created on demand.
		 * In integrated mode (`getDoc` provided), the doc is resolved via callback.
		 * Returns undefined if the room is rejected (getDoc returned undefined).
		 */
		join(
			roomId: string,
			wsRaw: object,
			send: (data: Buffer) => void,
		): { doc: Y.Doc; awareness: Awareness } | undefined {
			// Cancel pending eviction if a connection joins before the timer fires
			const existing = rooms.get(roomId);
			if (existing?.evictionTimer) {
				clearTimeout(existing.evictionTimer);
				existing.evictionTimer = undefined;
			}

			if (existing) {
				existing.conns.set(wsRaw, { send });
				return { doc: existing.doc, awareness: existing.awareness };
			}

			// Room doesn't exist yet — resolve or create the doc
			let doc: Y.Doc;
			if (config?.getDoc) {
				const resolved = config.getDoc(roomId);
				if (!resolved) return undefined;
				doc = resolved;
			} else {
				doc = new Y.Doc();
				config?.onRoomCreated?.(roomId, doc);
			}

			const awareness = new Awareness(doc);
			const room: Room = {
				doc,
				awareness,
				conns: new Map([[wsRaw, { send }]]),
			};
			rooms.set(roomId, room);

			return { doc, awareness };
		},

		/**
		 * Remove a connection from a room.
		 * Starts the eviction timer if the room becomes empty.
		 */
		leave(roomId: string, wsRaw: object): void {
			const room = rooms.get(roomId);
			if (!room) return;

			room.conns.delete(wsRaw);

			if (room.conns.size === 0) {
				room.evictionTimer = setTimeout(() => {
					// Verify still empty — a connection could have joined during the timer
					const current = rooms.get(roomId);
					if (!current || current.conns.size === 0) {
						rooms.delete(roomId);
						config?.onRoomEvicted?.(roomId, room.doc);
					}
				}, evictionTimeout);
			}
		},

		/**
		 * Send data to all connections in a room except the sender.
		 *
		 * @param excludeRaw - The ws.raw to exclude (typically the sender)
		 */
		broadcast(roomId: string, data: Buffer, excludeRaw?: object): void {
			const room = rooms.get(roomId);
			if (!room) return;

			for (const [raw, conn] of room.conns) {
				if (raw !== excludeRaw) {
					conn.send(data);
				}
			}
		},

		/** Get the Y.Doc for an existing room. */
		getDoc(roomId: string): Y.Doc | undefined {
			return rooms.get(roomId)?.doc;
		},

		/** Get the awareness instance for an existing room. */
		getAwareness(roomId: string): Awareness | undefined {
			return rooms.get(roomId)?.awareness;
		},

		/** List active room IDs. */
		rooms(): string[] {
			return [...rooms.keys()];
		},

		/** Destroy all rooms and clear timers. */
		destroy(): void {
			for (const room of rooms.values()) {
				if (room.evictionTimer) {
					clearTimeout(room.evictionTimer);
				}
			}
			rooms.clear();
		},
	};
}
