/**
 * Vocabulary for the runtime-agnostic room system.
 *
 * Hand-declared types that multiple backends implement and
 * {@link createRoomCore} consumes. The factory-per-backend pattern uses
 * `satisfies` to prove each backend's concrete return shape matches these
 * types while keeping that concrete shape navigable in editors.
 *
 * ## What lives here
 *
 * - {@link RoomUpdateLog}: per-room persistent update log. Backends supply
 *   the storage; the contract is synchronous because the Yjs `updateV2`
 *   callback that calls `append` cannot await.
 * - {@link RoomSocket}: the minimal per-connection WebSocket surface.
 *   Structural by design so both Cloudflare's hibernation `WebSocket` and
 *   Bun's `ServerWebSocket` satisfy it natively, no wrapper required.
 * - {@link ResolvedRoom} / {@link Rooms}: name-to-room routing
 *   consumed by route middleware in `app.ts`.
 * - {@link RoomError}: error variants surfaced across the room's
 *   untrusted-input boundaries (HTTP sync body, binary WebSocket frame).
 *
 * @see `room/core.ts` for the consumer (`createRoomCore`).
 * @see `room/backends/cloudflare/` for the Cloudflare backend.
 */

import type { UserId } from '@epicenter/auth';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

// ============================================================================
// RoomUpdateLog
// ============================================================================

/**
 * Persistent update log for one room's Yjs document.
 *
 * Backends pick their own storage; the Cloudflare backend wraps
 * `ctx.storage.sql`, a Bun backend would wrap a `bun:sqlite` file.
 * {@link createRoomCore} consumes this type and never knows which.
 *
 * Invariants:
 * - `loadAll()` returns entries in insertion order.
 * - `append(u)` is durable before the next call returns.
 * - `replaceAll(c)` is atomic with respect to readers.
 *
 * The contract is synchronous because the Yjs `updateV2` listener that
 * calls {@link RoomUpdateLog.append} cannot `await`. Both backends choose a
 * synchronous engine (`ctx.storage.sql` on Cloudflare, `bun:sqlite` on Bun),
 * which keeps the room logic identical across them.
 */
export type RoomUpdateLog = {
	/** All update entries in insertion order. Called once at room load. */
	loadAll(): Uint8Array[];
	/** Append one Yjs update. Sync because the Yjs listener cannot await. */
	append(update: Uint8Array): void;
	/** Replace the entire log with one compacted blob. Atomic. */
	replaceAll(compacted: Uint8Array): void;
	/** Total bytes used by the log; surfaced as `storageBytes` to callers. */
	byteSize(): number;
	/** Number of entries currently in the log; used to skip no-op compactions. */
	entryCount(): number;
};

// ============================================================================
// RoomSocket
// ============================================================================

/**
 * Minimal per-connection WebSocket surface used by {@link createRoomCore}.
 *
 * Structural by design: both Cloudflare's hibernation `WebSocket` and Bun's
 * `ServerWebSocket` satisfy this shape natively (TypeScript structural
 * typing), so no per-backend wrapper is needed. Backends pass the raw
 * socket to {@link RoomCore.addConnection}.
 *
 * Per-connection state that must survive runtime quirks (the
 * `Connection`) is tracked inside `RoomCore`'s own map. This contract
 * carries no attachment slot, because attachment persistence is
 * backend-specific (`serializeAttachment` on Cloudflare's hibernation API,
 * `ws.data` on Bun) and the adapter owns it.
 */
export type RoomSocket = {
	/** Send a text or binary frame. Backends may return a status; the contract is void. */
	send(data: string | Uint8Array): void;
	/** Close the socket with a code and reason. */
	close(code: number, reason: string): void;
	/** WebSocket-spec readyState (CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3). */
	readonly readyState: number;
	/**
	 * Persist per-connection state across the runtime's hibernate cycle.
	 * Cloudflare's hibernation API provides this; Bun and other backends
	 * with in-memory connection sets leave it undefined. The core calls it
	 * (if present) whenever the in-memory `Connection` changes, so peer
	 * state survives a DO eviction.
	 */
	serializeAttachment?(value: unknown): void;
};

// ============================================================================
// ResolvedRoom / Rooms
// ============================================================================

/**
 * One room resolved by name, exposing the per-room operations route
 * middleware calls.
 *
 * All methods are async because some backends (Cloudflare Durable Object
 * stubs) cross an isolate boundary. Bun's backend returns
 * `Promise.resolve` of synchronous results, satisfying the same contract.
 */
export type ResolvedRoom = {
	/**
	 * HTTP sync RPC. Apply the client's update to this room's doc and
	 * return the diff the client is missing (`null` if already in sync),
	 * along with the post-write storage size.
	 *
	 * Returns `Err(MalformedSyncBody)` when the untrusted body fails to
	 * decode so the route can answer 400.
	 */
	sync(
		body: Uint8Array,
	): Promise<
		Result<{ diff: Uint8Array | null; storageBytes: number }, RoomError>
	>;
	/**
	 * Snapshot bootstrap. Returns the full doc state via
	 * `Y.encodeStateAsUpdateV2`; clients apply this to hydrate before
	 * opening a WebSocket.
	 */
	getDoc(): Promise<{ data: Uint8Array; storageBytes: number }>;
	/**
	 * Accept a WebSocket upgrade for this room. The route resolves identity
	 * out-of-band ({@link RoomUpgrade}: `userId` from auth, `nodeId` from the
	 * client query) and the backend performs its runtime-specific accept,
	 * returning the HTTP response the route returns verbatim.
	 *
	 * Identity reaches the backend as data, not re-derived from auth, but each
	 * runtime then accepts the socket differently: the Cloudflare backend
	 * forwards the request to its Durable Object (which returns a 101), stamping
	 * the server-resolved `userId` into the forwarded URL the DO reads; the Bun
	 * backend hands the ORIGINAL request to `server.upgrade(request, { data })`
	 * (a reconstructed request cannot be upgraded) and carries the identity on
	 * the socket's `ws.data`. Both land the same {@link Connection} on
	 * `RoomCore.addConnection`.
	 */
	handleUpgrade(upgrade: RoomUpgrade): Promise<Response>;
};

/**
 * The identity and request a backend needs to accept one WebSocket upgrade.
 * `request` is the untouched inbound request (the Bun backend upgrades it in
 * place; the Cloudflare backend forwards a userId-stamped copy to its DO).
 * `userId` is the authenticated principal stamped server-side; `nodeId` is
 * the client's own dispatch address, validated present at the route boundary.
 */
export type RoomUpgrade = {
	request: Request;
	userId: UserId;
	nodeId: string;
};

/**
 * What a backend needs to reject one WebSocket upgrade with an application
 * close code. `request` is the untouched inbound request; `code`/`reason` are
 * the app close (4000-4999) and its serialized payload.
 */
export type RoomUpgradeRejection = {
	request: Request;
	code: number;
	reason: string;
};

/**
 * The runtime's room + WebSocket surface. The Cloudflare backend wraps
 * `DurableObjectNamespace`; a Bun backend wraps an in-process
 * `Map<string, RoomCore>` with lazy synchronous creation.
 *
 * The host-owned room name is built upstream by `doName(ownerId, roomId)`
 * in `owner.ts`, producing `owners/<ownerId>/rooms/<roomId>` in both modes
 * (in personal mode `ownerId === user.id`, in shared mode
 * `ownerId === 'shared'`).
 * This contract treats the name as opaque.
 */
export type Rooms = {
	/** Resolve a room by its opaque host-owned name. */
	get(name: string): ResolvedRoom;
	/**
	 * Reject a WebSocket upgrade with an application close code, on this runtime.
	 *
	 * The auth layer calls this when a room upgrade fails auth, before any room
	 * name is resolved (hence it is not behind {@link Rooms.get}). The socket is
	 * accepted and then immediately closed with `code`/`reason`, so the browser
	 * receives a readable close code: a plain HTTP error on an upgrade surfaces
	 * to a `WebSocket` only as an opaque failure, and the client's sync
	 * supervisor parks permanently only on a close code (4401), not a failed
	 * handshake. Runtime-specific, like {@link ResolvedRoom.handleUpgrade}: the
	 * Cloudflare backend uses a `WebSocketPair`, the Bun backend uses
	 * `server.upgrade` then `ws.close`.
	 */
	rejectUpgrade(rejection: RoomUpgradeRejection): Promise<Response>;
};

// ============================================================================
// Errors
// ============================================================================

/**
 * Errors surfaced across the room's untrusted-input boundaries.
 *
 * - `MessageDecode` covers the WebSocket binary frame path.
 * - `MalformedSyncBody` covers the HTTP sync RPC body.
 *
 * Both wrap lib0 buffer underflow (truncated input) and any other
 * decode-time exception thrown on untrusted bytes.
 */
export const RoomError = defineErrors({
	MessageDecode: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode WebSocket message: ${extractErrorMessage(cause)}`,
		cause,
	}),
	MalformedSyncBody: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode HTTP sync body: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/** Union of every room error variant. */
export type RoomError = InferErrors<typeof RoomError>;
