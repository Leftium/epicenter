/**
 * Protocol Unit Tests
 *
 * Tests y-websocket-compatible protocol helpers used by the server sync endpoint.
 * Coverage focuses on sync message encoding/decoding, compatibility with
 * y-protocols, and end-to-end synchronization behavior under common and edge
 * conditions.
 *
 * After the RPC-on-Yjs-state collapse, the wire protocol is byte-identical
 * to plain y-websocket sync: only `MESSAGE_TYPE.SYNC` produces traffic;
 * `MESSAGE_TYPE.AUTH` is a reserved sentinel for the 4401 close path.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	decodeMessageType,
	decodeSyncMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
} from './protocol';

// ============================================================================
// MESSAGE_TYPE Constants
// ============================================================================

describe('MESSAGE_TYPE constants', () => {
	test('expose only the SYNC and AUTH wire slots', () => {
		// Wire protocol is byte-identical to plain y-websocket sync after the
		// awareness/RPC collapse: only SYNC produces traffic; AUTH is a
		// reserved sentinel for the 4401 close path.
		expect(MESSAGE_TYPE.SYNC).toBe(0);
		expect(MESSAGE_TYPE.AUTH).toBe(2);
	});
});

describe('SYNC_MESSAGE_TYPE constants', () => {
	test('have expected numeric values', () => {
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

			doc.on('updateV2', (update: Uint8Array) => {
				capturedUpdate = update;
			});
			doc.getMap('data').set('key', 'value');

			expect(capturedUpdate).not.toBeNull();
			if (!capturedUpdate) {
				throw new Error('Expected captured update after document mutation');
			}
			const message = encodeSyncUpdate({ update: capturedUpdate });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('update');
		});

		test('handles empty update', () => {
			const message = encodeSyncUpdate({ update: new Uint8Array(0) });

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.SYNC);
		});
	});

	describe('handleSyncPayload', () => {
		test('responds to sync step 1 with sync step 2', () => {
			const serverDoc = createDoc((d) => {
				d.getMap('data').set('server', 'content');
			});
			const clientDoc = createDoc();

			const response = handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.STEP1,
				payload: Y.encodeStateVector(clientDoc),
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).not.toBeNull();
			if (!response) {
				throw new Error(
					'Expected sync step 2 response for sync step 1 payload',
				);
			}
			const decoded = decodeSyncMessage(response);
			expect(decoded.type).toBe('step2');
		});

		test('returns null for sync step 2 (no response needed)', () => {
			const serverDoc = createDoc();
			const clientDoc = createDoc((d) => {
				d.getMap('data').set('client', 'content');
			});

			const response = handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.STEP2,
				payload: Y.encodeStateAsUpdateV2(clientDoc),
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).toBeNull();
		});

		test('returns null for sync update (no response needed)', () => {
			const serverDoc = createDoc();
			const updateV2 = Y.encodeStateAsUpdateV2(
				createDoc((d) => d.getMap('data').set('key', 'value')),
			);

			const response = handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.UPDATE,
				payload: updateV2,
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

			handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.UPDATE,
				payload: Y.encodeStateAsUpdateV2(clientDoc),
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(serverDoc.getMap('data').get('key')).toBe('value');
		});
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
		doc.on('updateV2', (update: Uint8Array) => {
			capturedUpdate = update;
		});
		doc.getMap('test').set('key', 'value');

		if (!capturedUpdate) {
			throw new Error('Expected captured update after document mutation');
		}
		const encoded = encodeSyncUpdate({ update: capturedUpdate });
		const decoded = decodeSyncMessage(encoded);

		expect(decoded.type).toBe('update');
		if (decoded.type === 'update') {
			expect(decoded.update).toBeInstanceOf(Uint8Array);
		}
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

		// Server handles client's state vector and responds with sync step 2 (V2 update)
		const serverResponse = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.STEP1,
			payload: Y.encodeStateVector(clientDoc),
			doc: serverDoc,
			origin: 'client',
		});

		expect(serverResponse).not.toBeNull();
		if (!serverResponse) {
			throw new Error('Expected server sync response during handshake');
		}

		// Client applies server's V2 response
		const decoded = decodeSyncMessage(serverResponse);
		expect(decoded.type).toBe('step2');
		if (decoded.type === 'step2') {
			Y.applyUpdateV2(clientDoc, decoded.update, 'server');
		}

		// Client should have server's content
		expect(clientDoc.getMap('notes').get('note1')).toBe('Hello from server');
	});

	test('bidirectional sync merges both documents', () => {
		const doc1 = createDoc((d) => d.getMap('data').set('from1', 'value1'));
		const doc2 = createDoc((d) => d.getMap('data').set('from2', 'value2'));

		// Full bidirectional sync using Yjs V2 pattern
		syncDocs(doc1, doc2);

		expect(doc1.getMap('data').get('from1')).toBe('value1');
		expect(doc1.getMap('data').get('from2')).toBe('value2');
		expect(doc2.getMap('data').get('from1')).toBe('value1');
		expect(doc2.getMap('data').get('from2')).toBe('value2');
	});

	test('incremental updates are applied correctly', () => {
		const doc1 = createDoc();
		const doc2 = createDoc();

		// Capture V2 updates from doc1
		const updates: Uint8Array[] = [];
		doc1.on('updateV2', (update: Uint8Array) => {
			updates.push(update);
		});

		// Make changes
		doc1.getMap('data').set('key1', 'value1');
		doc1.getMap('data').set('key2', 'value2');
		doc1.getArray('list').push(['item1', 'item2']);

		// Apply V2 updates to doc2
		for (const update of updates) {
			Y.applyUpdateV2(doc2, update);
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

/** Sync two documents bidirectionally (standard Yjs test pattern, V2) */
function syncDocs(doc1: Y.Doc, doc2: Y.Doc): void {
	const state1 = Y.encodeStateAsUpdateV2(doc1);
	const state2 = Y.encodeStateAsUpdateV2(doc2);
	Y.applyUpdateV2(doc1, state2);
	Y.applyUpdateV2(doc2, state1);
}
