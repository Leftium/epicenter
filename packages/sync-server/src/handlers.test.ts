import { describe, expect, test } from 'bun:test';
import {
	encodeAwareness,
	encodeQueryAwareness,
	encodeSyncStep1,
	MESSAGE_TYPE,
} from '@epicenter/sync';
import * as encoding from 'lib0/encoding';
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { handleWsClose, handleWsMessage, handleWsOpen } from './handlers';

/** Create a fresh doc + awareness pair. */
function setup() {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	return { doc, awareness };
}

describe('handleWsOpen', () => {
	test('returns SyncStep1 as initial message', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const sent: Uint8Array[] = [];

		const { initialMessages } = handleWsOpen(doc, awareness, connId, (d) =>
			sent.push(d),
		);

		// At minimum, SyncStep1. May also include awareness if Awareness
		// has local state (it does by default for the doc's own clientID).
		expect(initialMessages.length).toBeGreaterThanOrEqual(1);
		// First message is always SyncStep1 — first varint is MESSAGE_TYPE.SYNC
		expect(initialMessages[0]![0]).toBe(MESSAGE_TYPE.SYNC);
	});

	test('includes awareness states when they exist', () => {
		const { doc, awareness } = setup();

		// Seed awareness state from a different client
		const otherDoc = new Y.Doc();
		const otherAwareness = new Awareness(otherDoc);
		otherAwareness.setLocalState({ name: 'Alice' });
		const update = encodeAwarenessUpdate(otherAwareness, [otherDoc.clientID]);
		applyAwarenessUpdate(awareness, update, null);

		const connId = {};
		const { initialMessages } = handleWsOpen(doc, awareness, connId, () => {});

		expect(initialMessages.length).toBe(2); // SyncStep1 + awareness
	});

	test('forwards doc updates to connection (excluding echo)', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const sent: Uint8Array[] = [];

		handleWsOpen(doc, awareness, connId, (d) => sent.push(d));

		// Update from a different origin — should be forwarded
		const otherDoc = new Y.Doc();
		otherDoc.getMap('test').set('key', 'value');
		const update = Y.encodeStateAsUpdateV2(otherDoc);
		Y.applyUpdateV2(doc, update, 'other-origin');

		expect(sent.length).toBe(1);

		// Update from same connId — should NOT be forwarded (echo prevention)
		const otherDoc2 = new Y.Doc();
		otherDoc2.getMap('test').set('key2', 'value2');
		const update2 = Y.encodeStateAsUpdateV2(otherDoc2);
		Y.applyUpdateV2(doc, update2, connId);

		expect(sent.length).toBe(1); // unchanged
	});
});

describe('handleWsMessage', () => {
	test('handles SYNC message and returns response for SyncStep1', () => {
		const { doc, awareness } = setup();
		doc.getMap('data').set('existing', 'content');

		const connId = {};
		const { state } = handleWsOpen(doc, awareness, connId, () => {});

		// Send a SyncStep1 from a "client" with an empty doc
		const clientDoc = new Y.Doc();
		const syncStep1 = encodeSyncStep1({ doc: clientDoc });

		const result = handleWsMessage(syncStep1, state);

		// Should respond with SyncStep2 containing the diff
		expect(result.response).toBeDefined();
		expect(result.broadcast).toBeUndefined();
	});

	test('handles AWARENESS message and returns broadcast', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const { state } = handleWsOpen(doc, awareness, connId, () => {});

		// Create an awareness update
		const clientDoc = new Y.Doc();
		const clientAwareness = new Awareness(clientDoc);
		clientAwareness.setLocalState({ cursor: { x: 10, y: 20 } });
		const awarenessUpdate = encodeAwarenessUpdate(clientAwareness, [
			clientDoc.clientID,
		]);
		const msg = encodeAwareness({ update: awarenessUpdate });

		const result = handleWsMessage(msg, state);

		// Awareness should be broadcast, not responded
		expect(result.broadcast).toBeDefined();
		expect(result.response).toBeUndefined();
	});

	test('handles QUERY_AWARENESS and returns current states', () => {
		const { doc, awareness } = setup();
		awareness.setLocalState({ name: 'Server' });

		const connId = {};
		const { state } = handleWsOpen(doc, awareness, connId, () => {});

		const msg = encodeQueryAwareness();
		const result = handleWsMessage(msg, state);

		expect(result.response).toBeDefined();
		expect(result.broadcast).toBeUndefined();
	});

	test('silently ignores SYNC_STATUS messages (removed feature)', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const { state } = handleWsOpen(doc, awareness, connId, () => {});

		// Craft a message with SYNC_STATUS type (102)
		const msg = encoding.encode((encoder) =>
			encoding.writeVarUint(encoder, 102),
		);
		const result = handleWsMessage(msg, state);

		expect(result).toEqual({});
	});

	test('returns empty result for unknown message types', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const { state } = handleWsOpen(doc, awareness, connId, () => {});

		// Craft a message with an unknown type (99)
		const msg = encoding.encode((encoder) =>
			encoding.writeVarUint(encoder, 99),
		);
		const result = handleWsMessage(msg, state);

		expect(result).toEqual({});
	});
});

describe('handleWsClose', () => {
	test('unregisters event handlers', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const sent: Uint8Array[] = [];

		const { state } = handleWsOpen(doc, awareness, connId, (d) => sent.push(d));

		handleWsClose(state);

		// After close, doc updates should NOT be forwarded
		const otherDoc = new Y.Doc();
		otherDoc.getMap('test').set('key', 'value');
		Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(otherDoc), 'other');

		expect(sent.length).toBe(0);
	});

	test('removes awareness states for controlled client IDs', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const { state } = handleWsOpen(doc, awareness, connId, () => {});

		// Simulate a client setting awareness through this connection
		const clientAwareness = new Awareness(new Y.Doc());
		clientAwareness.setLocalState({ name: 'Test' });
		const update = encodeAwarenessUpdate(clientAwareness, [
			clientAwareness.doc.clientID,
		]);

		const msg = encodeAwareness({ update });
		handleWsMessage(msg, state);

		// Awareness should have states
		expect(awareness.getStates().size).toBeGreaterThan(0);
		const controlledCount = state.controlledClientIds.size;
		expect(controlledCount).toBeGreaterThan(0);

		handleWsClose(state);

		// Controlled client IDs should be removed from awareness
		for (const id of state.controlledClientIds) {
			expect(awareness.getStates().has(id)).toBe(false);
		}
	});

	test('is safe to call twice', () => {
		const { doc, awareness } = setup();
		const connId = {};
		const { state } = handleWsOpen(doc, awareness, connId, () => {});

		handleWsClose(state);
		handleWsClose(state); // should not throw
	});
});
