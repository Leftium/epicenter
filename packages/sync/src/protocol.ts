/**
 * Yjs WebSocket Protocol Encoding/Decoding Utilities
 *
 * Pure functions for encoding and decoding y-websocket protocol messages.
 * Separates protocol handling from transport (WebSocket handling).
 *
 * All sync payloads use Yjs V2 encoding for ~40% smaller wire size.
 * State vectors are version-independent (same format for V1 and V2).
 *
 * Based on patterns from y-redis protocol.js:
 * - Message type constants as first-class exports
 * - Pure encoder/decoder functions
 * - Single responsibility: protocol only, no transport logic
 *
 * @see https://github.com/yjs/y-redis/blob/main/src/protocol.js
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { type Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

// ============================================================================
// Top-Level Message Types
// ============================================================================

/**
 * Top-level message types in the y-websocket protocol.
 * The first varint in any message identifies its type.
 */
export const MESSAGE_TYPE = {
	/** Document synchronization messages (sync step 1, 2, or update) */
	SYNC: 0,
	/** User presence/cursor information */
	AWARENESS: 1,
	/** Authentication (reserved for future use) */
	AUTH: 2,
	/** Request current awareness states from server */
	QUERY_AWARENESS: 3,
	/**
	 * Sync status heartbeat — extension beyond standard y-websocket protocol.
	 *
	 * Tag 102 sits safely outside the standard Yjs range (0–3). Any standard
	 * y-websocket implementation that doesn't recognize it will silently ignore it.
	 *
	 * ## How it works
	 *
	 * 1. Client increments a monotonic `localVersion` on every doc update.
	 * 2. Client sends `[102, varuint(localVersion)]` to the server.
	 * 3. Server echoes the raw payload back unchanged (zero parsing cost).
	 * 4. Client compares `ackedVersion` (from echo) to `localVersion`:
	 *    - `ackedVersion < localVersion` → `hasLocalChanges = true` ("Saving…")
	 *    - `ackedVersion >= localVersion` → `hasLocalChanges = false` ("Saved")
	 *
	 * ## Dead connection detection
	 *
	 * Also serves as a heartbeat. The client sends a probe after 2s of idle
	 * silence and arms a 3s response timeout — worst-case 5s detection window.
	 *
	 * ## Design (inspired by y-sweet)
	 *
	 * The server is intentionally dumb — it never parses the payload. This means
	 * the version semantics can evolve client-side without server changes.
	 *
	 * Wire format: `[varuint: 102] [varuint: payload length] [varuint: localVersion]`
	 */
	SYNC_STATUS: 102,
} as const;

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

/**
 * Decodes the top-level message type from raw message data.
 *
 * The first varint in any y-websocket message is the message type:
 * - 0: MESSAGE_SYNC (document sync)
 * - 1: MESSAGE_AWARENESS (user presence)
 * - 2: MESSAGE_AUTH (authentication, reserved)
 * - 3: MESSAGE_QUERY_AWARENESS (request awareness states)
 *
 * Useful for quickly determining message type before full parsing.
 *
 * @param data - Raw message bytes
 * @returns The message type constant (0=SYNC, 1=AWARENESS, etc.)
 */
export function decodeMessageType(data: Uint8Array): number {
	const decoder = decoding.createDecoder(data);
	return decoding.readVarUint(decoder);
}

// ============================================================================
// Sync Protocol (V2 encoding)
// ============================================================================

/**
 * Sub-message types within SYNC messages.
 * Derived from y-protocols/sync constants for consistency.
 *
 * These are the second varint in a SYNC message, after MESSAGE_TYPE.SYNC.
 */
export const SYNC_MESSAGE_TYPE = {
	/** Initial handshake: "here's my state vector, what am I missing?" */
	STEP1: 0,
	/** Response to STEP1: "here are the updates you're missing" */
	STEP2: 1,
	/** Incremental document update broadcast */
	UPDATE: 2,
} as const;

export type SyncMessageType =
	(typeof SYNC_MESSAGE_TYPE)[keyof typeof SYNC_MESSAGE_TYPE];

/**
 * Decoded sync message - discriminated union of the three sync sub-types.
 * Update payloads are V2-encoded.
 */
export type DecodedSyncMessage =
	| { type: 'step1'; stateVector: Uint8Array }
	| { type: 'step2'; update: Uint8Array }
	| { type: 'update'; update: Uint8Array };

/**
 * Encodes a sync step 1 message containing the document's state vector.
 *
 * This is the first message in the Yjs sync protocol handshake. The server
 * sends its state vector to the client, asking "what updates do you have
 * that I'm missing?" The client responds with sync step 2 containing any
 * updates the server doesn't have.
 *
 * State vector encoding is version-independent (same for V1 and V2).
 *
 * @param options.doc - The Yjs document to get the state vector from
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncStep1({ doc }: { doc: Y.Doc }): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP1);
		encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc));
	});
}

/**
 * Encodes a sync step 2 message containing the FULL document state (V2).
 *
 * Unlike the step 2 response generated by {@link handleSyncPayload} (which
 * computes a diff against the remote's state vector), this encodes the
 * entire document with no diffing. Useful for bootstrapping a fresh client
 * that has no prior state.
 *
 * @param options.doc - The Yjs document to encode in full
 * @returns Encoded MESSAGE_SYNC + STEP2 message with full doc state
 */
export function encodeSyncStep2({ doc }: { doc: Y.Doc }): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP2);
		encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdateV2(doc));
	});
}

/**
 * Encodes a document update message for broadcasting to clients.
 *
 * After initial sync, any changes to the document are broadcast as update
 * messages. These are incremental and can be applied in any order due to
 * Yjs's CRDT properties.
 *
 * @param options.update - V2-encoded Yjs update bytes (from doc.on('updateV2'))
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncUpdate({
	update,
}: {
	update: Uint8Array;
}): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.UPDATE);
		encoding.writeVarUint8Array(encoder, update);
	});
}

/**
 * Decodes a sync protocol message into its components.
 *
 * Pure decoder that returns the message type and payload without side effects.
 * Useful for testing, logging, and protocol inspection. Update payloads are
 * V2-encoded.
 *
 * @param data - Raw message bytes
 * @returns Decoded message with type discriminator and payload
 * @throws Error if message is not a valid SYNC message or has unknown sync type
 */
export function decodeSyncMessage(data: Uint8Array): DecodedSyncMessage {
	const decoder = decoding.createDecoder(data);
	const messageType = decoding.readVarUint(decoder);
	if (messageType !== MESSAGE_TYPE.SYNC) {
		throw new Error(`Expected SYNC message (0), got ${messageType}`);
	}

	const syncType = decoding.readVarUint(decoder);
	const payload = decoding.readVarUint8Array(decoder);

	switch (syncType) {
		case SYNC_MESSAGE_TYPE.STEP1:
			return { type: 'step1', stateVector: payload };
		case SYNC_MESSAGE_TYPE.STEP2:
			return { type: 'step2', update: payload };
		case SYNC_MESSAGE_TYPE.UPDATE:
			return { type: 'update', update: payload };
		default:
			throw new Error(`Unknown sync type: ${syncType}`);
	}
}

/**
 * Handle a decoded sync sub-message and return a response if needed.
 *
 * Pure-input alternative to y-protocols' `readSyncMessage` — accepts already-
 * decoded `syncType` and `payload` instead of a mutable lib0 decoder. The
 * caller reads these two fields from the decoder inline (consistent with how
 * AWARENESS and SYNC_STATUS cases are already handled).
 *
 * Dispatches on the three sync sub-types (all V2 encoded):
 * - STEP1: `payload` is a state vector → responds with a V2 diff (STEP2)
 * - STEP2: `payload` is a V2 update → applied to doc, no response
 * - UPDATE: `payload` is a V2 update → applied to doc, no response
 *
 * @param options.syncType - Which sync sub-message (STEP1, STEP2, or UPDATE)
 * @param options.payload - The sub-message bytes (state vector for STEP1, V2 update for STEP2/UPDATE)
 * @param options.doc - The Yjs document to sync. Mutated for STEP2/UPDATE via applyUpdateV2.
 * @param options.origin - Transaction origin passed to applyUpdateV2 (typically the connection, used to prevent echo)
 * @returns Encoded response message for STEP1, null otherwise
 */
export function handleSyncPayload({
	syncType,
	payload,
	doc,
	origin,
}: {
	syncType: SyncMessageType;
	payload: Uint8Array;
	doc: Y.Doc;
	origin: unknown;
}): Uint8Array | null {
	switch (syncType) {
		case SYNC_MESSAGE_TYPE.STEP1: {
			const diff = Y.encodeStateAsUpdateV2(doc, payload);
			return encoding.encode((encoder) => {
				encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
				encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP2);
				encoding.writeVarUint8Array(encoder, diff);
			});
		}
		case SYNC_MESSAGE_TYPE.STEP2:
		case SYNC_MESSAGE_TYPE.UPDATE: {
			Y.applyUpdateV2(doc, payload, origin);
			return null;
		}
		default:
			return null;
	}
}

// ============================================================================
// Sync Status Protocol (MESSAGE_SYNC_STATUS = 102)
// ============================================================================

/**
 * Encodes a MESSAGE_SYNC_STATUS message from a raw payload.
 *
 * The server uses this to echo the client's sync status payload back.
 * The payload is opaque bytes — the server never parses them.
 *
 * @param options.payload - Raw sync status bytes to echo back to the client
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncStatus({
	payload,
}: {
	payload: Uint8Array;
}): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC_STATUS);
		encoding.writeVarUint8Array(encoder, payload);
	});
}

/**
 * Decodes a MESSAGE_SYNC_STATUS message and returns the raw payload.
 *
 * @param data - Raw message bytes (including the 102 type prefix)
 * @returns The sync status payload bytes
 * @throws Error if message is not a valid SYNC_STATUS message
 */
export function decodeSyncStatus(data: Uint8Array): Uint8Array {
	const decoder = decoding.createDecoder(data);
	const messageType = decoding.readVarUint(decoder);
	if (messageType !== MESSAGE_TYPE.SYNC_STATUS) {
		throw new Error(`Expected SYNC_STATUS message (102), got ${messageType}`);
	}
	return decoding.readVarUint8Array(decoder);
}

// ============================================================================
// Awareness Protocol
// ============================================================================

/**
 * Encodes an awareness update message from raw awareness bytes.
 *
 * Awareness is used for ephemeral user presence data like cursor positions,
 * user names, and online status. Unlike document updates, awareness state
 * is not persisted and is cleared when users disconnect.
 *
 * @param options.update - Raw awareness update bytes (from encodeAwarenessUpdate)
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeAwareness({
	update,
}: {
	update: Uint8Array;
}): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.AWARENESS);
		encoding.writeVarUint8Array(encoder, update);
	});
}

/**
 * Encodes awareness states for specified clients.
 *
 * Convenience function that combines awareness encoding with message wrapping.
 * Typically used to send current awareness states to newly connected clients.
 *
 * @param options.awareness - The awareness instance containing client states
 * @param options.clients - Array of client IDs whose states should be encoded
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeAwarenessStates({
	awareness,
	clients,
}: {
	awareness: Awareness;
	clients: number[];
}): Uint8Array {
	return encodeAwareness({
		update: encodeAwarenessUpdate(awareness, clients),
	});
}

/**
 * Encodes a query awareness message.
 *
 * This message requests all current awareness states from the server.
 * Typically sent by clients that need to refresh their view of other users.
 *
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeQueryAwareness(): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.QUERY_AWARENESS);
	});
}

// ============================================================================
// HTTP Sync Request Encoding (binary frame format for POST body)
// ============================================================================

/**
 * Encode a single-round-trip HTTP sync request body.
 *
 * Collapses the WebSocket 3-message handshake (step1 → step2 → step2) into
 * one HTTP POST/response. The client bundles its state vector and an optional
 * update together:
 *
 *   Client POST: [stateVector, update?]
 *   Server response: V2 diff the client is missing (or 304 if already in sync)
 *
 * The state vector tells the server "what I already have." The update (if
 * present) pushes local changes the server is missing. The server applies the
 * update, then diffs against the client's state vector to produce the response.
 *
 * Wire format: two length-prefixed frames (lib0 varint encoding).
 *   Frame 1: stateVector (always present)
 *   Frame 2: update (zero-length Uint8Array when absent)
 *
 * @param stateVector - Client's Yjs state vector (tells server what client has)
 * @param update - Optional V2 Yjs update to push to the server
 * @returns Encoded binary request body
 */
export function encodeSyncRequest(
	stateVector: Uint8Array,
	update?: Uint8Array,
): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint8Array(encoder, stateVector);
		encoding.writeVarUint8Array(encoder, update ?? new Uint8Array(0));
	});
}

/**
 * Decode a single-round-trip HTTP sync request body.
 *
 * Parses the two length-prefixed frames from {@link encodeSyncRequest}.
 * The update field will be an empty Uint8Array (byteLength === 0) if
 * the client had nothing to push.
 *
 * @param data - Raw sync request body bytes
 * @returns Parsed state vector and update
 * @throws Error if data is malformed or truncated
 */
export function decodeSyncRequest(data: Uint8Array): {
	stateVector: Uint8Array;
	update: Uint8Array;
} {
	const decoder = decoding.createDecoder(data);
	const stateVector = decoding.readVarUint8Array(decoder);
	const update = decoding.readVarUint8Array(decoder);
	return { stateVector, update };
}

// ============================================================================
// State Vector Utilities
// ============================================================================

/** Compare two state vectors for byte-level equality. */
export function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
