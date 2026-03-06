/**
 * HTTP Sync Storage Foundation
 *
 * Storage interface and binary frame encoding for the HTTP polling sync protocol.
 * The server stores opaque binary blobs (Yjs updates) and uses pure Yjs utility
 * functions to compute diffs — no Y.Doc instantiation on the server side.
 *
 * Binary wire format for POST body:
 * Two length-prefixed frames using lib0 varint encoding:
 *   1. State vector (required) — tells the server what the client already has
 *   2. Update (optional, zero-length if nothing to push)
 *
 * @see ./protocol.ts for WebSocket protocol encoding patterns
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

// ============================================================================
// Storage Interface
// ============================================================================

/**
 * Append-only update log for Yjs document updates.
 *
 * Implementations store opaque binary blobs (Yjs updates) keyed by document ID.
 * The storage never interprets or parses the update contents — it simply
 * appends, reads, and compacts them.
 */
export type UpdateLog = {
	/**
	 * Append a Yjs update for a document.
	 *
	 * Updates are stored in arrival order. Each call adds one update to the
	 * end of the document's update log.
	 *
	 * @param docId - Unique document identifier
	 * @param update - Raw Yjs update bytes
	 */
	append(docId: string, update: Uint8Array): Promise<void>;

	/**
	 * Read all stored updates (snapshot + deltas) for a document.
	 *
	 * Returns updates in the order they were appended. After compaction,
	 * this returns a single-element array containing the merged snapshot.
	 *
	 * @param docId - Unique document identifier
	 * @returns Array of raw Yjs update bytes, empty array if document not found
	 */
	readAll(docId: string): Promise<Uint8Array[]>;

	/**
	 * Replace all updates with a single compacted snapshot.
	 *
	 * Atomically replaces the entire update log for a document with a single
	 * merged update. This reduces storage size and speeds up future reads.
	 *
	 * @param docId - Unique document identifier
	 * @param mergedUpdate - Single Yjs update containing all document state
	 */
	replaceAll(docId: string, mergedUpdate: Uint8Array): Promise<void>;
};

// ============================================================================
// Binary Frame Encoding/Decoding
// ============================================================================

/**
 * Encode a sync request body (state vector + optional update).
 *
 * Wire format: two length-prefixed frames using lib0 varint encoding.
 * The state vector frame is always present. The update frame is written
 * as a zero-length byte array when no update is provided.
 *
 * @param stateVector - Client's Yjs state vector (tells server what client has)
 * @param update - Optional Yjs update to push to the server
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
 * Decode a sync request body into state vector and optional update.
 *
 * Parses the two length-prefixed frames from an encoded sync request.
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

/**
 * Compare two state vectors for byte-level equality.
 *
 * Performs a simple length check followed by element-wise comparison.
 * This is used to detect whether a client's state has changed since
 * the last sync, enabling the server to skip unnecessary diff computation.
 *
 * @param a - First state vector
 * @param b - Second state vector
 * @returns True if both state vectors are identical byte-for-byte
 */
export function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// ============================================================================
// In-Memory Storage Implementation
// ============================================================================

/**
 * Create an in-memory UpdateLog backed by a Map.
 *
 * Suitable for testing and for remote server deployments where documents
 * are ephemeral (e.g., collaboration sessions that don't outlive the process).
 * All data is lost when the process exits.
 *
 * @returns An UpdateLog instance using in-memory storage
 */
export function createMemoryUpdateLog(): UpdateLog {
	const docs = new Map<string, Uint8Array[]>();

	return {
		async append(docId, update) {
			let updates = docs.get(docId);
			if (!updates) {
				updates = [];
				docs.set(docId, updates);
			}
			updates.push(update);
		},

		async readAll(docId) {
			return docs.get(docId) ?? [];
		},

		async replaceAll(docId, mergedUpdate) {
			docs.set(docId, [mergedUpdate]);
		},
	};
}
