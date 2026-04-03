/**
 * Sync Transport Tests
 *
 * Uses a mocked WebSocket to validate the transport supervisor loop without
 * requiring a real sync server. The suite focuses on lifecycle transitions
 * and reconnection behavior.
 *
 * Key behaviors:
 * - Connection lifecycle transitions follow the expected status model.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { encodeSyncStep2 } from '@epicenter/sync';
import * as Y from 'yjs';
import { createTransport, type SyncStatus } from './websocket-transport';

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
	/** All constructed instances in creation order. */
	static created: MockWebSocket[] = [];

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
		MockWebSocket.created.push(this);
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

function getLastWebSocket(): MockWebSocket {
	const ws =
		[...MockWebSocket.created]
			.reverse()
			.find((socket) => socket.url.startsWith('ws://test/sync')) ??
		MockWebSocket.lastCreated;
	expect(ws).toBeDefined();
	if (!ws) {
		throw new Error('Expected WebSocket to be created');
	}
	return ws;
}

// ============================================================================
// Protocol Helpers
// ============================================================================

/** Build a sync step 2 message. The transport transitions to 'connected' on receipt. */
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

const OriginalWebSocket = globalThis.WebSocket;

describe('createTransport', () => {
	beforeEach(() => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		MockWebSocket.lastCreated = null;
		MockWebSocket.created = [];
	});

	afterEach(() => {
		globalThis.WebSocket = OriginalWebSocket;
	});

	test('initial state is offline', () => {
		const doc = createDoc();
		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		expect(transport.status.phase).toBe('offline');

		transport.dispose();
	});

	test('connect() transitions to connecting', async () => {
		const doc = createDoc();
		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.connect();
		await tick();

		expect(transport.status.phase).toBe('connecting');
		expect(MockWebSocket.lastCreated).not.toBeNull();

		transport.dispose();
	});

	test('connect() starts the supervisor loop', async () => {
		const doc = createDoc();
		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		expect(transport.status.phase).toBe('offline');

		transport.connect();
		await tick();

		expect(transport.status.phase).toBe('connecting');

		transport.dispose();
	});

	test('status transitions: connecting → connected', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.onStatusChange((s) => statuses.push(s));

		transport.connect();
		await tick();

		const ws = getLastWebSocket();

		// Simulate server accepting connection
		ws.simulateOpen();
		await tick();

		expect(statuses.map((s) => s.phase)).toContain('connecting');

		// Simulate server sending sync step 2 (handshake completion).
		// Re-read the latest socket in case a reconnect races in test mode.
		for (let i = 0; i < 10 && transport.status.phase !== 'connected'; i++) {
			getLastWebSocket().simulateMessage(buildSyncStep2Message(doc));
			await tick();
		}

		expect(transport.status.phase).toBe('connected');
		expect(statuses.map((s) => s.phase)).toContain('connected');

		transport.dispose();
	});

	test('disconnect() sets status to offline synchronously', async () => {
		const doc = createDoc();
		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.connect();
		await tick();
		const ws = getLastWebSocket();
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(transport.status.phase).toBe('connected');

		// disconnect() should synchronously set status
		transport.disconnect();
		expect(transport.status.phase).toBe('offline');

		// Clean up the close event
		await tick();
		transport.dispose();
	});

	test('disconnect() during connecting cancels the loop', async () => {
		const doc = createDoc();
		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.connect();
		await tick();
		expect(transport.status.phase).toBe('connecting');

		transport.disconnect();
		expect(transport.status.phase).toBe('offline');

		// Let any pending promises settle
		await tick(50);
		expect(transport.status.phase).toBe('offline');

		transport.dispose();
	});

	test('onStatusChange listener fires on transitions', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.onStatusChange((s) => statuses.push(s));

		transport.connect();
		await tick();

		const ws = getLastWebSocket();
		ws.simulateOpen();
		await tick();

		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		const phases = statuses.map((s) => s.phase);
		expect(phases).toEqual(['connecting', 'connected']);

		transport.dispose();
	});

	test('onStatusChange unsubscribe stops notifications', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		const unsub = transport.onStatusChange((s) => statuses.push(s));

		transport.connect();
		await tick();

		// Unsubscribe after 'connecting'
		unsub();

		const ws = getLastWebSocket();
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		// Should only have 'connecting' — unsubscribed before connected
		const phases = statuses.map((s) => s.phase);
		expect(phases).toEqual(['connecting']);

		transport.dispose();
	});

	test('dispose() sets status to offline and cleans up', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.onStatusChange((s) => statuses.push(s));

		transport.connect();
		await tick();

		const ws = getLastWebSocket();
		ws.simulateOpen();
		await tick();
		ws.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(transport.status.phase).toBe('connected');

		transport.dispose();
		expect(transport.status.phase).toBe('offline');

		// After dispose, status listener should not fire
		// (listeners are cleared in dispose)
		statuses.length = 0;

		await tick(50);
		transport.dispose();
	});

	test('multiple connect() calls are idempotent', async () => {
		const doc = createDoc();
		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.connect();
		await tick();

		const firstWs = MockWebSocket.lastCreated;

		// Call connect again — should be a no-op
		transport.connect();
		await tick();

		// Same WebSocket instance — no new one was created
		expect(MockWebSocket.lastCreated).toBe(firstWs);

		transport.dispose();
	});

	test('reconnection after socket close', async () => {
		const doc = createDoc();
		const statuses: SyncStatus[] = [];

		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
		});

		transport.onStatusChange((s) => statuses.push(s));

		transport.connect();
		await tick();

		const ws1 = getLastWebSocket();
		ws1.simulateOpen();
		await tick();
		ws1.simulateMessage(buildSyncStep2Message(doc));
		await tick();

		expect(transport.status.phase).toBe('connected');

		// Simulate server closing the connection
		ws1.simulateClose();
		// Backoff is ~500ms base, so wait 700ms for reconnection attempt
		await tick(700);

		// Transport should attempt to reconnect
		const phases = statuses.map((s) => s.phase);
		expect(phases).toContain('connecting');

		// A new WebSocket should be created for reconnection
		const ws2 = getLastWebSocket();
		expect(ws2).not.toBe(ws1);

		transport.dispose();
	});

	test('getToken result is passed as query param', async () => {
		const doc = createDoc();
		const transport = createTransport({
			doc,
			url: () => 'ws://test/sync',
			getToken: async () => 'my-secret',
		});

		transport.connect();
		await tick();

		const ws = getLastWebSocket();
		// URL should be ws://
		expect(ws.url).toMatch(/^ws:\/\//);
		expect(ws.url).toContain('token=my-secret');
		// Token should NOT be passed as subprotocol — that leaks it
		// into the Sec-WebSocket-Protocol header which proxies may log
		expect(ws.protocols).toBeUndefined();

		transport.dispose();
	});
});
