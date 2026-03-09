/**
 * Sync Provider Tests
 *
 * Uses a mocked WebSocket to validate the provider supervisor loop without
 * requiring a real sync server. The suite focuses on lifecycle transitions
 * and reconnection behavior.
 *
 * Key behaviors:
 * - Connection lifecycle transitions follow the expected status model.
 */

import { describe, expect, test } from 'bun:test';
import { encodeSyncStep2 } from '@epicenter/sync';
import * as Y from 'yjs';
import { createSyncProvider } from './provider';
import type { SyncStatus, WebSocketConstructor } from './types';

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

	send(data: Uint8Array | string) {
		if (typeof data === 'string') return; // Text pings — ignore in mock
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

const MockWS: WebSocketConstructor = MockWebSocket;

function getLastWebSocket(): MockWebSocket {
	const ws = MockWebSocket.lastCreated;
	expect(ws).toBeDefined();
	if (!ws) {
		throw new Error('Expected WebSocket to be created');
	}
	return ws;
}

// ============================================================================
// Protocol Helpers
// ============================================================================

/** Build a sync step 2 message. The provider transitions to 'connected' on receipt. */
function buildSyncStep2Message(doc: Y.Doc): ArrayBuffer {
	return encodeSyncStep2({ doc }).buffer as ArrayBuffer;
}

// ============================================================================
// Utilities
// ============================================================================

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

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
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		expect(provider.status).toBe('offline');

		provider.destroy();
	});

	test('auto-connect transitions to connecting', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			baseUrl: 'http://test/sync',
			WebSocketConstructor: MockWS,
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
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		expect(provider.status).toBe('offline');

		provider.connect();
		await tick();

		expect(provider.status).toBe('connecting');

		provider.destroy();
	});

	test('status transitions: connecting → connected', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws = getLastWebSocket();

		// Simulate server accepting connection
		ws.simulateOpen();
		await tick();

		expect(statuses).toContain('connecting');

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
			baseUrl: 'http://test/sync',
			WebSocketConstructor: MockWS,
		});

		await tick();
		const ws = getLastWebSocket();
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
			baseUrl: 'http://test/sync',
			WebSocketConstructor: MockWS,
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
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws = getLastWebSocket();
		ws.simulateOpen();
		await tick();

		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(statuses).toEqual(['connecting', 'connected']);

		provider.destroy();
	});

	test('onStatusChange unsubscribe stops notifications', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		const unsub = provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		// Unsubscribe after 'connecting'
		unsub();

		const ws = getLastWebSocket();
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		// Should only have 'connecting' — unsubscribed before connected
		expect(statuses).toEqual(['connecting']);

		provider.destroy();
	});

	test('destroy() sets status to offline and cleans up', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const provider = createSyncProvider({
			doc,
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws = getLastWebSocket();
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

		await tick(50);
		provider.destroy();
	});

	test('multiple connect() calls are idempotent', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
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
			baseUrl: 'http://test/sync',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		provider.onStatusChange((s) => statuses.push(s));

		provider.connect();
		await tick();

		const ws1 = getLastWebSocket();
		ws1.simulateOpen();
		await tick();
		ws1.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(provider.status).toBe('connected');

		// Simulate server closing the connection
		ws1.simulateClose();
		// Backoff is ~500ms base, so wait 700ms for reconnection attempt
		await tick(700);

		// Provider should attempt to reconnect
		expect(statuses).toContain('connecting');

		// A new WebSocket should be created for reconnection
		const ws2 = getLastWebSocket();
		expect(ws2).not.toBe(ws1);

		provider.destroy();
	});

	test('getToken result is passed as query param', async () => {
		const doc = createDoc();
		const provider = createSyncProvider({
			doc,
			baseUrl: 'http://test/sync',
			getToken: async () => 'my-secret',
			connect: false,
			WebSocketConstructor: MockWS,
		});

		provider.connect();
		await tick();

		const ws = getLastWebSocket();
		// baseUrl http:// should be derived to ws://
		expect(ws.url).toMatch(/^ws:\/\//);
		expect(ws.url).toContain('token=my-secret');
		// Token should NOT be passed as subprotocol — that leaks it
		// into the Sec-WebSocket-Protocol header which proxies may log
		expect(ws.protocols).toBeUndefined();

		provider.destroy();
	});
});
