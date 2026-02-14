/**
 * Unit tests for createSyncProvider.
 *
 * Uses a MockWebSocket injected via WebSocketPolyfill to test the
 * supervisor loop, status transitions, hasLocalChanges tracking,
 * reconnection, and cleanup without a real server.
 */

import { describe, expect, test } from 'bun:test';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { createSyncProvider } from './provider';
import type { SyncStatus } from './types';

// ============================================================================
// Constants (must match provider.ts)
// ============================================================================

const MESSAGE_SYNC = 0;
const MESSAGE_SYNC_STATUS = 102;

// ============================================================================
// Mock WebSocket
// ============================================================================

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	/** Most recently constructed instance. */
	static lastCreated: MockWebSocket | null = null;

	readonly url: string;
	readonly protocols: string | string[] | undefined;
	readyState = MockWebSocket.CONNECTING;
	binaryType = 'arraybuffer';

	onopen: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	sentMessages: Uint8Array[] = [];

	constructor(url: string | URL, protocols?: string | string[]) {
		this.url = typeof url === 'string' ? url : url.toString();
		this.protocols = protocols;
		MockWebSocket.lastCreated = this;
	}

	send(data: Uint8Array) {
		this.sentMessages.push(data);
	}

	close() {
		if (
			this.readyState === MockWebSocket.CLOSED ||
			this.readyState === MockWebSocket.CLOSING
		) {
			return;
		}
		this.readyState = MockWebSocket.CLOSING;
		// Simulate async close event
		queueMicrotask(() => {
			this.readyState = MockWebSocket.CLOSED;
			this.onclose?.(new CloseEvent('close'));
		});
	}

	// --- Test helpers ---

	simulateOpen() {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.(new Event('open'));
	}

	simulateClose() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.(new CloseEvent('close'));
	}

	simulateError() {
		this.onerror?.(new Event('error'));
	}

	simulateMessage(data: ArrayBuffer) {
		this.onmessage?.(new MessageEvent('message', { data }));
	}
}

// ============================================================================
// Protocol Helpers
// ============================================================================

/**
 * Build a MESSAGE_SYNC message containing sync step 2 for a given doc.
 * When the provider receives this, it transitions to 'connected'.
 */
function buildSyncStep2Message(doc: Y.Doc): ArrayBuffer {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	syncProtocol.writeSyncStep2(encoder, doc);
	return encoding.toUint8Array(encoder).buffer;
}

/**
 * Build a MESSAGE_SYNC_STATUS (102) echo with a specific version.
 * The provider uses this to update ackedVersion.
 */
function buildSyncStatusEchoMessage(version: number): ArrayBuffer {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC_STATUS);

	const versionEncoder = encoding.createEncoder();
	encoding.writeVarUint(versionEncoder, version);
	encoding.writeVarUint8Array(encoder, encoding.toUint8Array(versionEncoder));

	return encoding.toUint8Array(encoder).buffer;
}

// ============================================================================
// Utilities
// ============================================================================

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function createDoc(init?: (doc: Y.Doc) => void): Y.Doc {
	const doc = new Y.Doc();
	if (init) init(doc);
	return doc;
}

// ============================================================================
// Tests
// ============================================================================

describe('createSyncProvider', () => {
	test('initial state with connect: false', () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		expect(provider.status).toBe('offline');
		// hasLocalChanges starts true: ackedVersion=-1, localVersion=0
		// This is correct — no server has confirmed anything yet
		expect(provider.hasLocalChanges).toBe(true);

		provider.destroy();
	});

	test('auto-connect transitions to connecting', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			WebSocketPolyfill: MockWebSocket as any,
		});

		// Auto-connect is default — loop starts asynchronously
		await tick();

		expect(provider.status).toBe('connecting');
		expect(MockWebSocket.lastCreated).not.toBeNull();

		provider.destroy();
	});

	test('connect() starts the supervisor loop', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		expect(provider.status).toBe('offline');

		provider.connect();
		await tick();

		expect(provider.status).toBe('connecting');

		provider.destroy();
	});

	test('status transitions: connecting → handshaking → connected', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws = MockWebSocket.lastCreated!;

		// Simulate server accepting connection
		ws.simulateOpen();
		await tick();

		expect(statuses).toContain('connecting');
		expect(statuses).toContain('handshaking');

		// Simulate server sending sync step 2 (handshake completion)
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(provider.status).toBe('connected');
		expect(statuses).toContain('connected');

		provider.destroy();
	});

	test('disconnect() sets status to offline synchronously', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			WebSocketPolyfill: MockWebSocket as any,
		});

		await tick();
		const ws = MockWebSocket.lastCreated!;
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(provider.status).toBe('connected');

		// disconnect() should synchronously set status
		provider.disconnect();
		expect(provider.status).toBe('offline');

		// Clean up the close event
		await tick();
		provider.destroy();
	});

	test('disconnect() during connecting cancels the loop', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			WebSocketPolyfill: MockWebSocket as any,
		});

		await tick();
		expect(provider.status).toBe('connecting');

		provider.disconnect();
		expect(provider.status).toBe('offline');

		// Let any pending promises settle
		await tick(50);
		expect(provider.status).toBe('offline');

		provider.destroy();
	});

	test('onStatusChange listener fires on transitions', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws = MockWebSocket.lastCreated!;
		ws.simulateOpen();
		await tick();

		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(statuses).toEqual(['connecting', 'handshaking', 'connected']);

		provider.destroy();
	});

	test('onStatusChange unsubscribe stops notifications', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		const unsub = provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		// Unsubscribe after 'connecting'
		unsub();

		const ws = MockWebSocket.lastCreated!;
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		// Should only have 'connecting' — unsubscribed before handshaking/connected
		expect(statuses).toEqual(['connecting']);

		provider.destroy();
	});

	test('hasLocalChanges tracks local edits and server ack', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.connect();
		await tick();

		const ws = MockWebSocket.lastCreated!;
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		// Initially true (ackedVersion=-1 !== localVersion=0)
		expect(provider.hasLocalChanges).toBe(true);

		// Server acks version 0 → becomes clean
		ws.simulateMessage(buildSyncStatusEchoMessage(0));
		await tick();

		expect(provider.hasLocalChanges).toBe(false);

		// Make a local edit → localVersion=1, ackedVersion=0 → dirty
		doc.getMap('test').set('key', 'value');

		expect(provider.hasLocalChanges).toBe(true);

		provider.destroy();
	});

	test('hasLocalChanges resets on sync status echo', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.connect();
		await tick();

		const ws = MockWebSocket.lastCreated!;
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		// First, ack version 0 to get to clean state
		ws.simulateMessage(buildSyncStatusEchoMessage(0));
		await tick();
		expect(provider.hasLocalChanges).toBe(false);

		// Make a local edit — increments localVersion to 1
		doc.getMap('test').set('key', 'value');
		expect(provider.hasLocalChanges).toBe(true);

		// Simulate server echoing sync status with version 1
		ws.simulateMessage(buildSyncStatusEchoMessage(1));
		await tick();

		expect(provider.hasLocalChanges).toBe(false);

		provider.destroy();
	});

	test('onLocalChanges listener fires on state changes', async () => {
		const doc = createDoc();
		const changes: boolean[] = [];

		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.onLocalChanges((hasChanges) => changes.push(hasChanges));

		provider.connect();
		await tick();

		const ws = MockWebSocket.lastCreated!;
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		// First ack version 0 to reach clean state
		// This fires the listener with false (ackedVersion catches up)
		ws.simulateMessage(buildSyncStatusEchoMessage(0));
		await tick();
		expect(changes).toContain(false);

		// Clear to track new transitions
		changes.length = 0;

		// Local edit → hasLocalChanges goes true
		doc.getMap('test').set('key', 'value');
		expect(changes).toEqual([true]);

		// Server echo version 1 → hasLocalChanges goes false
		ws.simulateMessage(buildSyncStatusEchoMessage(1));
		await tick();
		expect(changes).toEqual([true, false]);

		provider.destroy();
	});

	test('destroy() sets status to offline and cleans up', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws = MockWebSocket.lastCreated!;
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(provider.status).toBe('connected');

		provider.destroy();
		expect(provider.status).toBe('offline');

		// After destroy, status listener should not fire
		// (listeners are cleared in destroy)
		statuses.length = 0;

		// Making a doc edit should not fire localChanges listener either
		// (doc.off was called in destroy)
		doc.getMap('test').set('key', 'after-destroy');

		// hasLocalChanges is based on version counters which still update
		// via the doc listener, but after destroy the listener was removed.
		// The internal localVersion shouldn't increment after destroy.

		await tick(50);
		provider.destroy();
	});

	test('multiple connect() calls are idempotent', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.connect();
		await tick();

		const firstWs = MockWebSocket.lastCreated;

		// Call connect again — should be a no-op
		provider.connect();
		await tick();

		// Same WebSocket instance — no new one was created
		expect(MockWebSocket.lastCreated).toBe(firstWs);

		provider.destroy();
	});

	test('reconnection after socket close', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws1 = MockWebSocket.lastCreated!;
		ws1.simulateOpen();
		await tick();
		ws1.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(provider.status).toBe('connected');

		// Simulate server closing the connection
		ws1.simulateClose();
		// Backoff is ~500ms base, so wait 700ms for reconnection attempt
		await tick(700);

		// Provider should attempt to reconnect — status goes through error → connecting
		expect(statuses).toContain('error');

		// A new WebSocket should be created for reconnection
		const ws2 = MockWebSocket.lastCreated!;
		expect(ws2).not.toBe(ws1);

		provider.destroy();
	});

	test('static token is passed as query param and protocol', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			url: 'ws://test/sync',
			token: 'my-secret',
			connect: false,
			WebSocketPolyfill: MockWebSocket as any,
		});

		provider.connect();
		await tick();

		const ws = MockWebSocket.lastCreated!;
		expect(ws.url).toContain('token=my-secret');
		expect(ws.protocols).toEqual(['my-secret']);

		provider.destroy();
	});
});
