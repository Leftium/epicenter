/**
 * Shared factory functions for Durable Object rooms.
 *
 * Encapsulates the infrastructure glue (SQLite persistence, WebSocket
 * lifecycle, broadcast) that is identical between WorkspaceRoom and
 * DocumentRoom. The protocol-level sync logic stays in `sync-handlers.ts`.
 *
 * Three factories, each owning a distinct unit of coupled state:
 * - {@link createUpdateLog} — SQLite append-only update log + cold-start compaction
 * - {@link createConnectionHub} — WebSocket connection map + dispatch + broadcast
 * - {@link createAutoSaveTracker} — dedup auto-save on last disconnect
 */

import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from './constants';
import {
	Awareness,
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	safeBroadcast,
	swallow,
} from './sync-handlers';

export { Awareness };

// ============================================================================
// createUpdateLog
// ============================================================================

/**
 * Max compacted snapshot size (2 MB). Cloudflare DO SQLite enforces a hard
 * 2 MB per-row BLOB limit.
 *
 * On cold start, all update rows are merged into a single snapshot via
 * `Y.mergeUpdatesV2`. If the merged result fits under this limit, all rows
 * are atomically replaced with a single compacted row. This collapses
 * thousands of tiny keystroke-level updates into one row, dramatically
 * improving future cold-start load times.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Create an append-only Yjs update log backed by DO SQLite.
 *
 * Owns the full persistence lifecycle: DDL creation, cold-start loading with
 * opportunistic compaction, and live update persistence via `doc.on('updateV2')`.
 *
 * @example
 * ```typescript
 * const updateLog = createUpdateLog({
 *   sql: ctx.storage.sql,
 *   transactionSync: ctx.storage.transactionSync,
 * });
 * updateLog.init(doc);
 * ```
 */
export function createUpdateLog({
	sql,
	transactionSync,
}: {
	sql: SqlStorage;
	transactionSync: <T>(fn: () => T) => T;
}) {
	return {
		/**
		 * Initialize the update log: create the table, load persisted updates
		 * into the doc, compact if beneficial, and register the live persist handler.
		 *
		 * Must be called inside `blockConcurrencyWhile` to ensure the doc is
		 * ready before any `fetch()` or `webSocketMessage()` runs.
		 */
		init(doc: Y.Doc) {
			sql.exec(`
				CREATE TABLE IF NOT EXISTS updates (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL
				)
			`);

			const rows = sql.exec('SELECT data FROM updates ORDER BY id').toArray();

			if (rows.length > 0) {
				const merged = Y.mergeUpdatesV2(
					rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
				);
				Y.applyUpdateV2(doc, merged);

				if (rows.length > 1 && merged.byteLength <= MAX_COMPACTED_BYTES) {
					transactionSync(() => {
						sql.exec('DELETE FROM updates');
						sql.exec('INSERT INTO updates (data) VALUES (?)', merged);
					});
				}
			}

			doc.on('updateV2', (update: Uint8Array) => {
				sql.exec('INSERT INTO updates (data) VALUES (?)', update);
			});
		},
	};
}

// ============================================================================
// createConnectionHub
// ============================================================================

/** Per-connection metadata persisted via `ws.serializeAttachment` to survive hibernation. */
type WsAttachment = {
	controlledClientIds: number[];
};

/**
 * Create a WebSocket connection hub that manages the full lifecycle:
 * upgrade, dispatch, broadcast, close, error, and hibernation restoration.
 *
 * Owns the `Map<WebSocket, ConnectionState>` — the only shared mutable state
 * in the DO's WebSocket handling. Delegates protocol logic to `sync-handlers.ts`.
 *
 * @example
 * ```typescript
 * const hub = createConnectionHub({
 *   ctx,
 *   doc: this.doc,
 *   awareness,
 *   onAllDisconnected: () => autoSave.checkAndSave(),
 * });
 * hub.restoreHibernated();
 *
 * // In DO methods:
 * fetch(req) { return hub.upgrade(); }
 * webSocketMessage(ws, msg) { hub.dispatch(ws, msg); }
 * webSocketClose(ws, code, reason) { hub.close(ws, code, reason); }
 * webSocketError(ws, err) { hub.error(ws); }
 * ```
 */
export function createConnectionHub({
	ctx,
	doc,
	awareness,
	onAllDisconnected,
}: {
	ctx: DurableObjectState;
	doc: Y.Doc;
	awareness: Awareness;
	onAllDisconnected?: () => void;
}) {
	const states = new Map<WebSocket, ConnectionState>();

	return {
		/** Number of active WebSocket connections. */
		get size() {
			return states.size;
		},

		/**
		 * Restore connections that survived hibernation.
		 *
		 * Iterates `ctx.getWebSockets()`, deserializes each attachment to recover
		 * controlled awareness client IDs, and re-registers sync handlers.
		 * Must be called inside `blockConcurrencyWhile`.
		 */
		restoreHibernated() {
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;

				const { state } = handleWsOpen(doc, awareness, ws);
				for (const id of attachment.controlledClientIds) {
					state.controlledClientIds.add(id);
				}
				states.set(ws, state);
			}
		},

		/**
		 * Handle a WebSocket upgrade request.
		 *
		 * Creates a WebSocketPair, accepts via the Hibernation API, registers
		 * sync handlers, sends initial messages (SyncStep1 + awareness), and
		 * returns the 101 response.
		 */
		upgrade(): Response {
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];

			ctx.acceptWebSocket(server);

			const { initialMessages, state } = handleWsOpen(doc, awareness, server);
			states.set(server, state);

			server.serializeAttachment({
				controlledClientIds: [],
			} satisfies WsAttachment);

			for (const msg of initialMessages) {
				server.send(msg);
			}

			return new Response(null, { status: 101, webSocket: client });
		},

		/**
		 * Dispatch an incoming WebSocket message: validate size, decode via
		 * sync-handlers, process effects (respond, broadcast, persist attachment).
		 */
		dispatch(ws: WebSocket, message: ArrayBuffer | string) {
			const state = states.get(ws);
			if (!state) return;

			const byteLength =
				message instanceof ArrayBuffer ? message.byteLength : message.length;
			if (byteLength > MAX_PAYLOAD_BYTES) {
				ws.close(1009, 'Message too large');
				return;
			}

			const data =
				message instanceof ArrayBuffer
					? new Uint8Array(message)
					: new TextEncoder().encode(message);

			const { data: effects, error } = handleWsMessage(data, state);
			if (error) {
				console.error(error.message);
				return;
			}

			for (const effect of effects) {
				switch (effect.type) {
					case 'respond':
						ws.send(effect.data);
						break;
					case 'broadcast':
						safeBroadcast(states, ws, effect.data);
						break;
					case 'persistAttachment':
						ws.serializeAttachment({
							controlledClientIds: [...state.controlledClientIds],
						} satisfies WsAttachment);
						break;
				}
			}
		},

		/**
		 * Clean up a closed WebSocket: unregister handlers, remove from map,
		 * and fire `onAllDisconnected` if this was the last connection.
		 */
		close(ws: WebSocket, code: number, reason: string) {
			const state = states.get(ws);
			if (!state) return;

			handleWsClose(state);
			states.delete(ws);

			swallow(() => ws.close(code, reason));

			if (states.size === 0) {
				onAllDisconnected?.();
			}
		},

		/**
		 * Handle a WebSocket error by closing with code 1011.
		 */
		error(ws: WebSocket) {
			this.close(ws, 1011, 'WebSocket error');
		},
	};
}

// ============================================================================
// createAutoSaveTracker
// ============================================================================

/**
 * Create a tracker that auto-saves a snapshot when all clients disconnect,
 * but only if the document changed since the last save.
 *
 * Encapsulates the `lastAutoSaveSV` state + dedup comparison logic.
 * Wire as the `onAllDisconnected` callback of a connection hub.
 *
 * @example
 * ```typescript
 * const autoSave = createAutoSaveTracker({
 *   doc,
 *   save: () => this.saveSnapshot('Auto-save'),
 * });
 * const hub = createConnectionHub({
 *   ctx, doc, awareness,
 *   onAllDisconnected: autoSave.checkAndSave,
 * });
 * ```
 */
export function createAutoSaveTracker({
	doc,
	save,
}: {
	doc: Y.Doc;
	save: () => void;
}) {
	let lastSavedSv: Uint8Array | null = null;

	return {
		/**
		 * Check if the document changed since the last save, and save if so.
		 *
		 * Compares the current state vector against the one recorded at the
		 * last save. Uses `stateVectorsEqual` for a byte-level comparison
		 * that avoids false positives from Yjs client ID reuse.
		 */
		checkAndSave() {
			const currentSv = Y.encodeStateVector(doc);
			if (!lastSavedSv || !stateVectorsEqual(currentSv, lastSavedSv)) {
				lastSavedSv = currentSv;
				save();
			}
		},
	};
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Compare two Yjs state vectors for byte-level equality.
 *
 * Inlined here to avoid importing from `@epicenter/sync` — keeps
 * room-helpers self-contained for its one use in auto-save dedup.
 */
function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
