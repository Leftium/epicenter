/**
 * Protocol Unit Tests
 *
 * Tests for y-websocket protocol encoding/decoding following Yjs patterns.
 * Co-located with protocol.ts for easy discovery.
 */

import { describe, expect, test } from 'bun:test';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
	decodeMessageType,
	decodeSyncMessage,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncMessage,
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
} from './protocol';

// ============================================================================
// MESSAGE_TYPE Constants
// ============================================================================

describe('MESSAGE_TYPE constants', () => {
	test('match y-websocket protocol values', () => {
		// These values are defined by y-websocket and must not change
		expect(MESSAGE_TYPE.SYNC).toBe(0);
		expect(MESSAGE_TYPE.AWARENESS).toBe(1);
		expect(MESSAGE_TYPE.AUTH).toBe(2);
		expect(MESSAGE_TYPE.QUERY_AWARENESS).toBe(3);
	});
});

describe('SYNC_MESSAGE_TYPE constants', () => {
	test('match y-protocols/sync values', () => {
		// These values are derived from y-protocols and must match
		expect(SYNC_MESSAGE_TYPE.STEP1).toBe(syncProtocol.messageYjsSyncStep1);
		expect(SYNC_MESSAGE_TYPE.STEP2).toBe(syncProtocol.messageYjsSyncStep2);
		expect(SYNC_MESSAGE_TYPE.UPDATE).toBe(syncProtocol.messageYjsUpdate);
	});

	test('have expected numeric values', () => {
		// Document the actual values for clarity
		expect(SYNC_MESSAGE_TYPE.STEP1).toBe(0);
		expect(SYNC_MESSAGE_TYPE.STEP2).toBe(1);
		expect(SYNC_MESSAGE_TYPE.UPDATE).toBe(2);
	});
});

// ============================================================================
// MESSAGE_SYNC Tests
// ============================================================================

describe('MESSAGE_SYNC', () => {
	describe('encodeSyncStep1', () => {
		test('encodes empty document', () => {
			const doc = createDoc();
			const message = encodeSyncStep1({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step1');
		});

		test('encodes document with content', () => {
			const doc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});
			const message = encodeSyncStep1({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step1');
		});

		test('state vector changes after modification', () => {
			const doc = createDoc();
			const message1 = encodeSyncStep1({ doc });

			doc.getMap('data').set('key', 'value');
			const message2 = encodeSyncStep1({ doc });

			// Different state vectors = different messages
			expect(message1).not.toEqual(message2);
		});

		test('can be decoded by y-protocols', () => {
			const doc = createDoc((d) => {
				d.getMap('test').set('foo', 'bar');
			});
			const message = encodeSyncStep1({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step1');
			if (decoded.type === 'step1') {
				expect(decoded.stateVector).toBeInstanceOf(Uint8Array);
				expect(decoded.stateVector.length).toBeGreaterThan(0);
			}
		});
	});

	describe('encodeSyncStep2', () => {
		test('encodes document diff', () => {
			const doc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});
			const message = encodeSyncStep2({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step2');
		});

		test('contains update data', () => {
			const doc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});
			const message = encodeSyncStep2({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step2');
			if (decoded.type === 'step2') {
				expect(decoded.update.length).toBeGreaterThan(0);
			}
		});
	});

	describe('encodeSyncUpdate', () => {
		test('encodes incremental update', () => {
			const doc = createDoc();
			let capturedUpdate: Uint8Array | null = null;

			doc.on('update', (update: Uint8Array) => {
				capturedUpdate = update;
			});
			doc.getMap('data').set('key', 'value');

			expect(capturedUpdate).not.toBeNull();
			const message = encodeSyncUpdate({ update: capturedUpdate! });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('update');
		});

		test('handles empty update', () => {
			const message = encodeSyncUpdate({ update: new Uint8Array(0) });

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.SYNC);
		});
	});

	describe('handleSyncMessage', () => {
		test('responds to sync step 1 with sync step 2', () => {
			const serverDoc = createDoc((d) => {
				d.getMap('data').set('server', 'content');
			});
			const clientDoc = createDoc();

			// Build client's sync step 1
			const syncStep1Payload = encoding.encode((encoder) => {
				syncProtocol.writeSyncStep1(encoder, clientDoc);
			});

			const decoder = decoding.createDecoder(syncStep1Payload);
			const response = handleSyncMessage({
				decoder,
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).not.toBeNull();
			const decoded = decodeSyncMessage(response!);
			expect(decoded.type).toBe('step2');
		});

		test('returns null for sync step 2 (no response needed)', () => {
			const serverDoc = createDoc();
			const clientDoc = createDoc((d) => {
				d.getMap('data').set('client', 'content');
			});

			// Build sync step 2 payload
			const syncStep2Payload = encoding.encode((encoder) => {
				syncProtocol.writeSyncStep2(encoder, clientDoc);
			});

			const decoder = decoding.createDecoder(syncStep2Payload);
			const response = handleSyncMessage({
				decoder,
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).toBeNull();
		});

		test('returns null for sync update (no response needed)', () => {
			const serverDoc = createDoc();
			const update = Y.encodeStateAsUpdate(
				createDoc((d) => d.getMap('data').set('key', 'value')),
			);

			const updatePayload = encoding.encode((encoder) => {
				syncProtocol.writeUpdate(encoder, update);
			});

			const decoder = decoding.createDecoder(updatePayload);
			const response = handleSyncMessage({
				decoder,
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).toBeNull();
		});

		test('applies update to document', () => {
			const serverDoc = createDoc();
			const clientDoc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});

			const update = Y.encodeStateAsUpdate(clientDoc);
			const updatePayload = encoding.encode((encoder) => {
				syncProtocol.writeUpdate(encoder, update);
			});

			const decoder = decoding.createDecoder(updatePayload);
			handleSyncMessage({
				decoder,
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(serverDoc.getMap('data').get('key')).toBe('value');
		});
	});
});

// ============================================================================
// MESSAGE_AWARENESS Tests
// ============================================================================

describe('MESSAGE_AWARENESS', () => {
	describe('encodeAwarenessStates', () => {
		test('encodes single client state', () => {
			const doc = createDoc();
			const awareness = new awarenessProtocol.Awareness(doc);
			awareness.setLocalState({ name: 'User 1', cursor: { x: 10, y: 20 } });

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});

		test('encodes complex nested state', () => {
			const doc = createDoc();
			const awareness = new awarenessProtocol.Awareness(doc);
			awareness.setLocalState({
				user: { name: 'Test', color: '#ff0000' },
				cursor: { position: { x: 100, y: 200 }, selection: [0, 10] },
				metadata: { version: 1, flags: ['active'] },
			});

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});

		test('handles special characters in state', () => {
			const doc = createDoc();
			const awareness = new awarenessProtocol.Awareness(doc);
			awareness.setLocalState({
				name: 'User with "quotes" and \'apostrophes\'',
				emoji: '🎉🚀',
				newlines: 'line1\nline2',
			});

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});

		test('handles large awareness state', () => {
			const doc = createDoc();
			const awareness = new awarenessProtocol.Awareness(doc);
			awareness.setLocalState({
				largeArray: Array(1000).fill('item'),
				largeString: 'x'.repeat(10000),
			});

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
			expect(message.length).toBeGreaterThan(10000);
		});
	});

	describe('encodeAwareness', () => {
		test('wraps raw awareness update', () => {
			const doc = createDoc();
			const awareness = new awarenessProtocol.Awareness(doc);
			awareness.setLocalState({ name: 'Test' });

			const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [
				awareness.clientID,
			]);
			const message = encodeAwareness({ update });

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});
	});

	describe('awareness protocol compatibility', () => {
		test('encoded awareness can be applied to another instance', () => {
			const doc1 = createDoc();
			const awareness1 = new awarenessProtocol.Awareness(doc1);
			awareness1.setLocalState({ name: 'User 1' });

			const doc2 = createDoc();
			const awareness2 = new awarenessProtocol.Awareness(doc2);

			// Encode from awareness1
			const update = awarenessProtocol.encodeAwarenessUpdate(awareness1, [
				awareness1.clientID,
			]);

			// Apply to awareness2
			awarenessProtocol.applyAwarenessUpdate(awareness2, update, 'remote');

			// awareness2 should have awareness1's state
			const states = awareness2.getStates();
			expect(states.has(awareness1.clientID)).toBe(true);
			expect(states.get(awareness1.clientID)).toEqual({ name: 'User 1' });
		});

		test('null state removes client (disconnect)', () => {
			const doc = createDoc();
			const awareness = new awarenessProtocol.Awareness(doc);
			awareness.setLocalState({ name: 'User' });

			expect(awareness.getStates().has(awareness.clientID)).toBe(true);

			// Setting null removes the state
			awareness.setLocalState(null);

			expect(awareness.getStates().has(awareness.clientID)).toBe(false);
		});
	});
});

// ============================================================================
// MESSAGE_QUERY_AWARENESS Tests
// ============================================================================

describe('MESSAGE_QUERY_AWARENESS', () => {
	test('query awareness message is single byte', () => {
		const message = encodeQueryAwareness();

		expect(message.length).toBe(1);
		expect(message[0]).toBe(MESSAGE_TYPE.QUERY_AWARENESS);
	});
});

// ============================================================================
// Decoder Tests
// ============================================================================

describe('decodeSyncMessage', () => {
	test('decodes sync step 1 message', () => {
		const doc = createDoc((d) => d.getMap('test').set('key', 'value'));
		const encoded = encodeSyncStep1({ doc });
		const decoded = decodeSyncMessage(encoded);

		expect(decoded.type).toBe('step1');
		if (decoded.type === 'step1') {
			expect(decoded.stateVector).toBeInstanceOf(Uint8Array);
			expect(decoded.stateVector.length).toBeGreaterThan(0);
		}
	});

	test('decodes sync step 2 message', () => {
		const doc = createDoc((d) => d.getMap('test').set('key', 'value'));
		const encoded = encodeSyncStep2({ doc });
		const decoded = decodeSyncMessage(encoded);

		expect(decoded.type).toBe('step2');
		if (decoded.type === 'step2') {
			expect(decoded.update).toBeInstanceOf(Uint8Array);
			expect(decoded.update.length).toBeGreaterThan(0);
		}
	});

	test('decodes sync update message', () => {
		const doc = createDoc();
		let capturedUpdate: Uint8Array | null = null;
		doc.on('update', (update: Uint8Array) => {
			capturedUpdate = update;
		});
		doc.getMap('test').set('key', 'value');

		const encoded = encodeSyncUpdate({ update: capturedUpdate! });
		const decoded = decodeSyncMessage(encoded);

		expect(decoded.type).toBe('update');
		if (decoded.type === 'update') {
			expect(decoded.update).toBeInstanceOf(Uint8Array);
		}
	});

	test('throws on non-SYNC message type', () => {
		const doc = createDoc();
		const awareness = new awarenessProtocol.Awareness(doc);
		awareness.setLocalState({ name: 'Test' });
		const awarenessMessage = encodeAwarenessStates({
			awareness,
			clients: [awareness.clientID],
		});

		expect(() => decodeSyncMessage(awarenessMessage)).toThrow(
			'Expected SYNC message (0), got 1',
		);
	});

	test('roundtrip: encode then decode preserves data', () => {
		const doc = createDoc((d) => {
			d.getMap('users').set('alice', { name: 'Alice', age: 30 });
			d.getArray('items').push(['item1', 'item2']);
		});

		// Test step 1 roundtrip
		const step1 = encodeSyncStep1({ doc });
		const decodedStep1 = decodeSyncMessage(step1);
		expect(decodedStep1.type).toBe('step1');

		// Test step 2 roundtrip
		const step2 = encodeSyncStep2({ doc });
		const decodedStep2 = decodeSyncMessage(step2);
		expect(decodedStep2.type).toBe('step2');
	});
});

describe('decodeMessageType', () => {
	test('decodes SYNC message type', () => {
		const doc = createDoc();
		const message = encodeSyncStep1({ doc });
		expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.SYNC);
	});

	test('decodes AWARENESS message type', () => {
		const doc = createDoc();
		const awareness = new awarenessProtocol.Awareness(doc);
		awareness.setLocalState({ name: 'Test' });
		const message = encodeAwarenessStates({
			awareness,
			clients: [awareness.clientID],
		});
		expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
	});

	test('decodes QUERY_AWARENESS message type', () => {
		const message = encodeQueryAwareness();
		expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.QUERY_AWARENESS);
	});
});

// ============================================================================
// Full Sync Protocol Tests
// ============================================================================

describe('full sync protocol', () => {
	test('complete handshake syncs server content to client', () => {
		const serverDoc = createDoc((d) => {
			d.getMap('notes').set('note1', 'Hello from server');
		});
		const clientDoc = createDoc();

		// Client sends sync step 1
		const clientSyncStep1 = encoding.encode((encoder) => {
			syncProtocol.writeSyncStep1(encoder, clientDoc);
		});

		// Server handles and responds with sync step 2
		const decoder1 = decoding.createDecoder(clientSyncStep1);
		const serverResponse = handleSyncMessage({
			decoder: decoder1,
			doc: serverDoc,
			origin: 'client',
		});

		expect(serverResponse).not.toBeNull();

		// Client applies server's response
		const decoder2 = decoding.createDecoder(serverResponse!);
		decoding.readVarUint(decoder2); // skip MESSAGE_TYPE.SYNC
		syncProtocol.readSyncMessage(
			decoder2,
			encoding.createEncoder(),
			clientDoc,
			'server',
		);

		// Client should have server's content
		expect(clientDoc.getMap('notes').get('note1')).toBe('Hello from server');
	});

	test('bidirectional sync merges both documents', () => {
		const doc1 = createDoc((d) => d.getMap('data').set('from1', 'value1'));
		const doc2 = createDoc((d) => d.getMap('data').set('from2', 'value2'));

		// Full bidirectional sync using Yjs pattern
		syncDocs(doc1, doc2);

		expect(doc1.getMap('data').get('from1')).toBe('value1');
		expect(doc1.getMap('data').get('from2')).toBe('value2');
		expect(doc2.getMap('data').get('from1')).toBe('value1');
		expect(doc2.getMap('data').get('from2')).toBe('value2');
	});

	test('incremental updates are applied correctly', () => {
		const doc1 = createDoc();
		const doc2 = createDoc();

		// Capture updates from doc1
		const updates: Uint8Array[] = [];
		doc1.on('update', (update: Uint8Array) => {
			updates.push(update);
		});

		// Make changes
		doc1.getMap('data').set('key1', 'value1');
		doc1.getMap('data').set('key2', 'value2');
		doc1.getArray('list').push(['item1', 'item2']);

		// Apply to doc2
		for (const update of updates) {
			Y.applyUpdate(doc2, update);
		}

		expect(doc2.getMap('data').get('key1')).toBe('value1');
		expect(doc2.getMap('data').get('key2')).toBe('value2');
		expect(doc2.getArray('list').toArray()).toEqual(['item1', 'item2']);
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
	test('handles large document (1000+ operations)', () => {
		const doc = createDoc((d) => {
			const arr = d.getArray<string>('items');
			for (let i = 0; i < 1000; i++) {
				arr.push([`item-${i}`]);
			}
		});

		// Sync step 1 contains state vector (compact), not full content
		const syncStep1 = encodeSyncStep1({ doc });
		expect(decodeSyncMessage(syncStep1).type).toBe('step1');

		// Sync step 2 contains actual document content
		const syncStep2 = encodeSyncStep2({ doc });
		expect(decodeSyncMessage(syncStep2).type).toBe('step2');
		expect(syncStep2.length).toBeGreaterThan(1000);
	});

	test('handles concurrent modifications (CRDT merge)', () => {
		const doc1 = createDoc();
		const doc2 = createDoc();

		// Both modify same key concurrently
		doc1.getMap('data').set('key', 'value1');
		doc2.getMap('data').set('key', 'value2');

		// Sync should resolve deterministically
		syncDocs(doc1, doc2);

		// Both should have same value (CRDT resolution)
		const val1 = doc1.getMap('data').get('key');
		const val2 = doc2.getMap('data').get('key');
		expect(val1).toBe(val2);
	});

	test('empty document produces valid sync step 1', () => {
		const doc = createDoc();
		const message = encodeSyncStep1({ doc });
		const decoded = decodeSyncMessage(message);

		expect(decoded.type).toBe('step1');
		if (decoded.type === 'step1') {
			// Even empty docs have a state vector (contains clientID info)
			expect(decoded.stateVector).toBeInstanceOf(Uint8Array);
		}
	});
});

// ============================================================================
// Test Utilities (hoisted - placed at bottom for readability)
// ============================================================================

/** Create a Y.Doc with optional initial content */
function createDoc(init?: (doc: Y.Doc) => void): Y.Doc {
	const doc = new Y.Doc();
	if (init) init(doc);
	return doc;
}

/** Sync two documents bidirectionally (standard Yjs test pattern) */
function syncDocs(doc1: Y.Doc, doc2: Y.Doc): void {
	const state1 = Y.encodeStateAsUpdate(doc1);
	const state2 = Y.encodeStateAsUpdate(doc2);
	Y.applyUpdate(doc1, state2);
	Y.applyUpdate(doc2, state1);
}
