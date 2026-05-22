/**
 * Sync handler tests.
 *
 * `sync-handlers.ts` owns one job: decode an untrusted binary WebSocket
 * frame and turn a lib0 decode failure into a typed `Result` error. It
 * does not own protocol semantics. STEP1 -> STEP2, STEP2/UPDATE apply,
 * and the unknown sub-type fall-through all belong to `@epicenter/sync`'s
 * `handleSyncPayload`, covered in `packages/sync/src/protocol.test.ts`.
 * The room-level binary update fan-out is covered in `presence.test.ts`.
 *
 * So this file tests only what `applyMessage` adds on top of
 * `handleSyncPayload`:
 *   - the binary frame decode is wired through to a reply frame,
 *   - a truncated frame is caught as `Err(MessageDecode)` rather than
 *     thrown out of the WebSocket message handler,
 *   - a decodable but out-of-range sub-type is a safe no-op.
 */

import { describe, expect, test } from 'bun:test';
import { encodeSyncStep1, SYNC_MESSAGE_TYPE } from '@epicenter/sync';
import { expectErr, expectOk } from '@epicenter/test-utils/result';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

import { applyMessage } from './sync-handlers';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Distinct object identity standing in for a WebSocket. `applyMessage` only
 * uses `ws` as the Yjs transaction origin, so no send/readyState surface is
 * needed.
 */
class MockWebSocket {}

/** A `MockWebSocket` typed as the CF `WebSocket` the handlers expect. */
function mockWs(): WebSocket {
	return new MockWebSocket() as unknown as WebSocket;
}

/** A well-formed binary frame: sync sub-type varint + payload. */
function frameWithSyncType(
	syncType: number,
	payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
	return encoding.encode((enc) => {
		encoding.writeVarUint(enc, syncType);
		encoding.writeVarUint8Array(enc, payload);
	});
}

// ============================================================================
// applyMessage
// ============================================================================

describe('applyMessage', () => {
	test('decodes a STEP1 frame and wires the dispatch through to a STEP2 reply', () => {
		const doc = new Y.Doc();
		doc.getMap('data').set('seed', 'value');

		const step1 = encodeSyncStep1({ doc: new Y.Doc() });

		const reply = expectOk(applyMessage({ data: step1, doc, ws: mockWs() }));

		if (!reply) throw new Error('Expected a STEP2 reply frame');
		expect(reply[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});

	test('catches a truncated frame as Err(MessageDecode) instead of throwing', () => {
		// A sync sub-type varint followed by a length prefix claiming 10
		// payload bytes that are not present: lib0 `readVarUint8Array`
		// underflows. This is the boundary `applyMessage` exists to guard.
		const truncated = new Uint8Array([SYNC_MESSAGE_TYPE.UPDATE, 10]);

		const error = expectErr(
			applyMessage({ data: truncated, doc: new Y.Doc(), ws: mockWs() }),
		);

		expect(error.name).toBe('MessageDecode');
	});

	test('treats a decodable but out-of-range sub-type as a no-op', () => {
		const reply = expectOk(
			applyMessage({
				data: frameWithSyncType(99),
				doc: new Y.Doc(),
				ws: mockWs(),
			}),
		);

		expect(reply).toBeNull();
	});
});
