/**
 * Sync handler integration tests.
 *
 * Exercises the slimmed `applyMessage` / `registerConnection` surface:
 * y-protocols/sync frames (a binary frame is a sync frame) and the
 * connection-update broadcast wiring.
 *
 * Dispatch text-frame correlation is covered against the Durable Object
 * elsewhere (`room.dispatch` tests). This file deliberately does not
 * exercise text frames; `applyMessage` is a binary-only dispatcher.
 *
 * AWARENESS routing and `liveness.installationId` validation are gone:
 * presence is server-owned (see `presence.test.ts`) and the relay no
 * longer maintains a y-protocols Awareness instance.
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

import {
	applyMessage,
	type Connection,
	registerConnection,
} from './sync-handlers';

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

function makeConnection(
	doc: Y.Doc,
	installationId = 'self-install',
): {
	ws: MockWebSocket;
	connection: Connection;
} {
	const ws = new MockWebSocket();
	const connection = registerConnection({
		doc,
		ws: ws as unknown as WebSocket,
		installationId,
	});
	return { ws, connection };
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
// registerConnection
// ============================================================================

describe('registerConnection', () => {
	test('forwards doc updates from other origins to the socket', () => {
		const doc = new Y.Doc();
		const { ws } = makeConnection(doc);

		doc.transact(() => {
			doc.getMap('data').set('hello', 'world');
		}, 'some-other-origin');

		expect(ws.sent.length).toBe(1);
		const sent = ws.sent[0] as Uint8Array;
		expect(sent[0]).toBe(SYNC_MESSAGE_TYPE.UPDATE);
	});

	test('skips echo when origin is the connection itself', () => {
		const doc = new Y.Doc();
		const ws = new MockWebSocket();
		const connection = registerConnection({
			doc,
			ws: ws as unknown as WebSocket,
			installationId: 'self-install',
		});

		doc.transact(() => {
			doc.getMap('data').set('hello', 'world');
		}, connection.ws);

		expect(ws.sent.length).toBe(0);
	});

	test('unregister stops forwarding doc updates', () => {
		const doc = new Y.Doc();
		const ws = new MockWebSocket();
		const connection = registerConnection({
			doc,
			ws: ws as unknown as WebSocket,
			installationId: 'self-install',
		});

		doc.transact(() => {
			doc.getMap('data').set('pre', 1);
		}, 'other-origin');
		expect(ws.sent.length).toBe(1);

		connection.unregister();

		doc.transact(() => {
			doc.getMap('data').set('post', 2);
		}, 'other-origin');
		expect(ws.sent.length).toBe(1);
	});
});

// ============================================================================
// applyMessage: SYNC
// ============================================================================

describe('applyMessage SYNC STEP1', () => {
	test('replies with a STEP2 frame containing the server diff', () => {
		const doc = new Y.Doc();
		doc.getMap('data').set('seed', 'value');

		const clientDoc = new Y.Doc();
		const step1 = encodeSyncStep1({ doc: clientDoc });

		const { connection } = makeConnection(doc);
		const reply = expectOk(
			applyMessage({
				data: step1,
				doc,
				ws: connection.ws,
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
		const { connection } = makeConnection(doc);

		const reply = expectOk(
			applyMessage({
				data: step2,
				doc,
				ws: connection.ws,
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
		const { connection } = makeConnection(doc);

		const reply = expectOk(
			applyMessage({
				data: frame,
				doc,
				ws: connection.ws,
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
		const { connection } = makeConnection(doc);

		const reply = expectOk(
			applyMessage({
				data: frameWithSyncType(99),
				doc,
				ws: connection.ws,
			}),
		);

		expect(reply).toBeNull();
	});
});
