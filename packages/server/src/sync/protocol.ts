/**
 * Yjs WebSocket Protocol Encoding/Decoding Utilities
 *
 * Pure functions for encoding and decoding y-websocket protocol messages.
 * Separates protocol handling from transport (WebSocket handling).
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
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

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
	 * Sync status heartbeat (extension beyond standard y-websocket protocol).
	 *
	 * Tag 102 is safely outside the standard Yjs protocol range (0–3).
	 * Any y-websocket client/server that doesn't understand it simply ignores it.
	 *
	 * The client sends its `localVersion` as a varuint payload. The server echoes
	 * the raw payload back unchanged. This enables:
	 * - `hasLocalChanges` tracking (client compares acked vs local version)
	 * - Fast heartbeat (2s probe + 3s timeout = 5s dead connection detection)
	 * - Zero server-side cost (echo only, never parsed)
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
// Sync Protocol
// ============================================================================

/**
 * Sub-message types within SYNC messages.
 * Derived from y-protocols/sync constants for consistency.
 *
 * These are the second varint in a SYNC message, after MESSAGE_TYPE.SYNC.
 */
export const SYNC_MESSAGE_TYPE = {
	/** Initial handshake: "here's my state vector, what am I missing?" */
	STEP1: syncProtocol.messageYjsSyncStep1,
	/** Response to STEP1: "here are the updates you're missing" */
	STEP2: syncProtocol.messageYjsSyncStep2,
	/** Incremental document update broadcast */
	UPDATE: syncProtocol.messageYjsUpdate,
} as const;

export type SyncMessageType =
	(typeof SYNC_MESSAGE_TYPE)[keyof typeof SYNC_MESSAGE_TYPE];

/**
 * Decoded sync message - discriminated union of the three sync sub-types.
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
 * @param options.doc - The Yjs document to get the state vector from
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncStep1({ doc }: { doc: Y.Doc }): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		syncProtocol.writeSyncStep1(encoder, doc);
	});
}

/**
 * Encodes a sync step 2 message containing the document diff.
 *
 * This is the response to sync step 1. It contains all updates that the
 * receiver is missing based on their state vector. After both sides exchange
 * sync step 1 and 2, they are fully synchronized.
 *
 * @param options.doc - The Yjs document to compute the diff from
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncStep2({ doc }: { doc: Y.Doc }): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		syncProtocol.writeSyncStep2(encoder, doc);
	});
}

/**
 * Encodes a document update message for broadcasting to clients.
 *
 * After initial sync, any changes to the document are broadcast as update
 * messages. These are incremental and can be applied in any order due to
 * Yjs's CRDT properties.
 *
 * @param options.update - The raw Yjs update bytes (from doc.on('update'))
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncUpdate({
	update,
}: {
	update: Uint8Array;
}): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		syncProtocol.writeUpdate(encoder, update);
	});
}

/**
 * Decodes a sync protocol message into its components.
 *
 * Pure decoder that returns the message type and payload without side effects.
 * Useful for testing, logging, and protocol inspection.
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
 * Handles an incoming sync message and returns a response if needed.
 *
 * This wraps y-protocols' readSyncMessage which has a read-and-write pattern:
 * it reads the incoming message, applies it to the document, and potentially
 * writes a response to an encoder.
 *
 * The sync protocol has three sub-message types:
 * - SyncStep1 (0): Client sends state vector, server responds with SyncStep2
 * - SyncStep2 (1): Contains document diff, no response needed
 * - Update (2): Incremental update, no response needed
 *
 * Only SyncStep1 triggers a response (SyncStep2 containing the diff).
 *
 * @param options.decoder - Decoder positioned after the MESSAGE_SYNC type byte
 * @param options.doc - The Yjs document to sync
 * @param options.origin - Transaction origin (typically the WebSocket, used to prevent echo)
 * @returns Encoded response message if one was generated, null otherwise
 */
export function handleSyncMessage({
	decoder,
	doc,
	origin,
}: {
	decoder: decoding.Decoder;
	doc: Y.Doc;
	origin: unknown;
}): Uint8Array | null {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
	syncProtocol.readSyncMessage(decoder, encoder, doc, origin);

	// Only return if there's content beyond the message type byte.
	// readSyncMessage only writes a response for SyncStep1 messages.
	return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
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
 * @param options.update - Raw awareness update bytes (from awarenessProtocol.encodeAwarenessUpdate)
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
	awareness: awarenessProtocol.Awareness;
	clients: number[];
}): Uint8Array {
	return encodeAwareness({
		update: awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
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
