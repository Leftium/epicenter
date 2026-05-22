/**
 * Yjs binary sync-frame decoder for the relay's WebSocket path.
 *
 * Framework-free: kept in its own module so {@link applyMessage} can be
 * unit-tested without the Durable Object harness.
 *
 * ## API surface
 *
 * {@link applyMessage}: decodes a binary sync frame, mutates the doc, and
 * returns the reply frame or null.
 *
 * ## Wire surfaces
 *
 * Binary frames handled here carry Yjs document sync (y-protocols/sync
 * framing: STEP1/STEP2/UPDATE). A binary frame is a sync frame; there is
 * no top-level message-type discriminator.
 *
 * Dispatch (`dispatch_inbound` / `dispatch_response`) and presence (the
 * `presence` full-list frame) ride on WebSocket *text* frames and are
 * handled outside this module.
 *
 * ## Error handling rationale (grounded in Yjs internals)
 *
 * `Y.applyUpdateV2` is resilient by design: it never throws on malformed
 * data. Missing dependencies are stored in `doc.store.pendingStructs` and
 * automatically retried when future updates arrive.
 *
 * However, `lib0/decoding` functions (readVarUint, readVarUint8Array) DO
 * throw on buffer underflow. Since WebSocket messages are untrusted input,
 * `applyMessage` wraps the decode+dispatch path with `trySync` to catch
 * these at the system boundary.
 */

import { handleSyncPayload, type SyncMessageType } from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { trySync } from 'wellcrafted/result';
import * as Y from 'yjs';

// ============================================================================
// Errors
// ============================================================================

/**
 * Errors from the sync handler layer.
 *
 * `MessageDecode` covers all failures when processing untrusted WebSocket
 * binary frames: lib0 buffer underflow (truncated messages) and any other
 * decode-time exceptions.
 */
const SyncHandlerError = defineErrors({
	MessageDecode: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode WebSocket message: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// ============================================================================
// Message dispatcher
// ============================================================================

/**
 * Dispatch an incoming binary WebSocket message.
 *
 * A binary frame is a sync frame: the first varint is the sync sub-type,
 * with no top-level message-type discriminator. Mutates `doc` as
 * appropriate, then returns `Result<Uint8Array | null>`: the STEP2 reply
 * frame for a SYNC STEP1, or `null` for the "valid, no reply" outcome
 * (STEP2/UPDATE applied to the doc, with fan-out to peers handled by the
 * room-level `updateV2` listener owned by the `Room` DO).
 *
 * `Err(SyncHandlerError.MessageDecode)` covers lib0 buffer underflow on
 * truncated input.
 */
export function applyMessage({
	data,
	doc,
	ws,
}: {
	data: Uint8Array;
	doc: Y.Doc;
	ws: WebSocket;
}) {
	return trySync({
		try: (): Uint8Array | null => {
			const decoder = decoding.createDecoder(data);
			const syncType = decoding.readVarUint(decoder) as SyncMessageType;
			const payload = decoding.readVarUint8Array(decoder);
			const response = handleSyncPayload({
				syncType,
				payload,
				doc,
				origin: ws,
			});
			return response ?? null;
		},
		catch: (cause) => SyncHandlerError.MessageDecode({ cause }),
	});
}
