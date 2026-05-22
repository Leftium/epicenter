/**
 * Sync handler tests.
 *
 * Exercises `applyMessage`: a binary frame is a y-protocols/sync frame
 * (sync sub-type varint + payload), decoded and applied to the doc.
 *
 * Update fan-out to peer sockets is no longer wired per-connection here;
 * it is a single room-level `updateV2` listener owned by the `Room` DO,
 * covered in `presence.test.ts`.
 *
 * Dispatch text-frame correlation is covered against the Durable Object
 * elsewhere (`room.dispatch` tests). This file deliberately does not
 * exercise text frames; `applyMessage` is a binary-only dispatcher.
 */

import { describe, expect, test } from 'bun:test';
import {
	encodeSyncStep1,
	encodeSyncUpdate,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import { expectOk } from '@epicenter/test-utils/result';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

import { applyMessage } from './sync-handlers';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Minimal stand-in for a Cloudflare WebSocket. `send` captures outbound
 * frames so tests can assert on them; `readyState = 1` matches
 * `WebSocket.OPEN` so production code probing readiness is happy.
 */
class MockWebSocket {
	sent: Array<Uint8Array | string> = [];
	readyState = 1;
	send(data: Uint8Array | string): void {
		this.sent.push(data);
	}
}

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
// applyMessage: SYNC
// ============================================================================

describe('applyMessage SYNC STEP1', () => {
	test('replies with a STEP2 frame containing the server diff', () => {
		const doc = new Y.Doc();
		doc.getMap('data').set('seed', 'value');

		const clientDoc = new Y.Doc();
		const step1 = encodeSyncStep1({ doc: clientDoc });

		const reply = expectOk(
			applyMessage({
				data: step1,
				doc,
				ws: mockWs(),
			}),
		);

		if (!reply) throw new Error('Expected a STEP2 reply frame');
		expect(reply[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});
});

describe('applyMessage SYNC STEP2 / UPDATE', () => {
	test('STEP2 payload applies state to the target doc, no effect emitted', () => {
		const source = new Y.Doc();
		source.getMap('data').set('shared', 'yes');
		const step2 = frameWithSyncType(
			SYNC_MESSAGE_TYPE.STEP2,
			Y.encodeStateAsUpdateV2(source),
		);

		const doc = new Y.Doc();

		const reply = expectOk(
			applyMessage({
				data: step2,
				doc,
				ws: mockWs(),
			}),
		);

		expect(reply).toBeNull();
		expect(doc.getMap('data').get('shared')).toBe('yes');
	});

	test('UPDATE payload applies state to the target doc, no effect emitted', () => {
		const source = new Y.Doc();
		source.getMap('data').set('hello', 'world');
		const update = Y.encodeStateAsUpdateV2(source);
		const frame = encodeSyncUpdate({ update });

		const doc = new Y.Doc();

		const reply = expectOk(
			applyMessage({
				data: frame,
				doc,
				ws: mockWs(),
			}),
		);

		expect(reply).toBeNull();
		expect(doc.getMap('data').get('hello')).toBe('world');
	});
});

// ============================================================================
// Unknown sync sub-types
// ============================================================================

describe('applyMessage unknown sync sub-type', () => {
	test('out-of-range sync sub-type is a no-op', () => {
		const doc = new Y.Doc();

		const reply = expectOk(
			applyMessage({
				data: frameWithSyncType(99),
				doc,
				ws: mockWs(),
			}),
		);

		expect(reply).toBeNull();
	});
});
