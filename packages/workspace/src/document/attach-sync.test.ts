/// <reference lib="dom" />

/**
 * attachSync — SYNC_STATUS `hasLocalChanges` round-trip.
 *
 * The meaningful SYNC_STATUS behavior is narrow: every local doc update
 * bumps `localVersion`, a debounced probe sends the counter to the server,
 * the server echoes it back, and the echo drives `hasLocalChanges` toward
 * `false`. This test drives that loop with a minimal in-process WebSocket
 * stub — enough to observe the probe on the wire and inject the ack.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
	decodeRpcPayload,
	encodeRpcRequest,
	encodeSyncStatus,
	encodeSyncStep2,
	isRpcError,
	MESSAGE_TYPE,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { attachSync } from './attach-sync.js';

// ── Minimal WebSocket stub ───────────────────────────────────────────────

type Listener = (ev: { data: ArrayBuffer | string }) => void;

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	binaryType: 'arraybuffer' | 'blob' = 'blob';
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: Listener | null = null;

	readonly sent: Uint8Array[] = [];
	readonly protocols: string[];

	constructor(public readonly url: string, protocols?: string | string[]) {
		this.protocols = Array.isArray(protocols)
			? protocols
			: protocols
				? [protocols]
				: [];
		FakeWebSocket.instances.push(this);
		// Synthesize `open` on a microtask so attachSync's handlers are wired.
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.onopen?.();
		});
	}

	send(data: Uint8Array | string) {
		if (typeof data === 'string') return;
		this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
	}

	close() {
		if (
			this.readyState === FakeWebSocket.CLOSED ||
			this.readyState === FakeWebSocket.CLOSING
		)
			return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}

	addEventListener() {}
	removeEventListener() {}

	/** Deliver a binary frame to the client. */
	deliver(frame: Uint8Array) {
		this.onmessage?.({
			data: frame.buffer.slice(
				frame.byteOffset,
				frame.byteOffset + frame.byteLength,
			) as ArrayBuffer,
		});
	}
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
	return () => {
		(globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
	};
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Decode a message's top-level type without consuming the rest. */
function peekMessageType(frame: Uint8Array): number {
	return decoding.readVarUint(decoding.createDecoder(frame));
}

/** Build a server-sent STEP2 frame for the (empty) remote doc. */
function serverStep2Frame(): Uint8Array {
	const remote = new Y.Doc();
	const frame = encodeSyncStep2({ doc: remote });
	remote.destroy();
	return frame;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 1000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value !== undefined && value !== false) return value;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timeout waiting for predicate');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('attachSync hasLocalChanges', () => {
	test('connected status exposes hasLocalChanges: false after clean handshake', async () => {
		const ydoc = new Y.Doc({ guid: 'test-doc-1' });
		const sync = attachSync(ydoc, { url: (id) => `ws://x/${id}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		expect(sync.status).toEqual({
			phase: 'connected',
			hasLocalChanges: false,
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('local update sends debounced SYNC_STATUS probe; echo flips hasLocalChanges back to false', async () => {
		const ydoc = new Y.Doc({ guid: 'test-doc-2' });
		const sync = attachSync(ydoc, { url: (id) => `ws://x/${id}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		const statuses: unknown[] = [];
		const unsubscribe = sync.onStatusChange((s) => statuses.push(s));

		// Local update → localVersion increments; SYNC_STATUS goes out after 100ms.
		ydoc.getMap('m').set('k', 'v');

		const probe = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.SYNC_STATUS) return frame;
			}
			return undefined;
		}, 500);

		// The probe payload is [100, localVersion].
		const dec = decoding.createDecoder(probe);
		expect(decoding.readVarUint(dec)).toBe(MESSAGE_TYPE.SYNC_STATUS);
		const probedVersion = decoding.readVarUint(dec);
		expect(probedVersion).toBeGreaterThan(0);

		// Server echoes the probe back unchanged → ackedVersion catches up,
		// the connected-variant emits hasLocalChanges=false.
		ws.deliver(encodeSyncStatus(probedVersion));

		await waitFor(() => statuses.length > 0);
		expect(sync.status).toEqual({
			phase: 'connected',
			hasLocalChanges: false,
		});

		unsubscribe();
		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('requiresToken:true blocks the first connect until setToken arrives, then sends token via subprotocol', async () => {
		const ydoc = new Y.Doc({ guid: 'test-token-gate' });
		const sync = attachSync(ydoc, {
			url: (id) => `ws://x/${id}`,
			requiresToken: true,
		});

		await waitFor(
			() =>
				sync.status.phase === 'connecting' &&
				sync.status.lastError?.type === 'auth',
		);
		expect(FakeWebSocket.instances.length).toBe(0);

		sync.setToken('abc123');

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		expect(ws.protocols).toContain('bearer.abc123');

		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('setToken while connected does not close the open socket', async () => {
		const ydoc = new Y.Doc({ guid: 'test-token-live' });
		const sync = attachSync(ydoc, {
			url: (id) => `ws://x/${id}`,
			requiresToken: true,
		});

		sync.setToken('first');
		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		expect(ws.protocols).toContain('bearer.first');
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		sync.setToken('second');
		expect(ws.readyState).toBe(FakeWebSocket.OPEN);
		expect(FakeWebSocket.instances.length).toBe(1);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('goOffline() closes the socket, prevents reconnect, and reconnect() re-opens', async () => {
		const ydoc = new Y.Doc({ guid: 'test-offline' });
		const sync = attachSync(ydoc, { url: (id) => `ws://x/${id}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		sync.goOffline();
		expect(sync.status).toEqual({ phase: 'offline' });
		expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

		// Give the supervisor a beat to confirm it's NOT re-opening on its own.
		await new Promise((r) => setTimeout(r, 50));
		expect(FakeWebSocket.instances.length).toBe(1);

		sync.reconnect();
		const ws2 = await waitFor(() => FakeWebSocket.instances[1]);
		await waitFor(() => ws2.readyState === FakeWebSocket.OPEN);
		ws2.deliver(serverStep2Frame());
		await waitFor(() => sync.status.phase === 'connected');

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC request without dispatch config responds with ActionNotFound', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-no-dispatch' });
		const sync = attachSync(ydoc, { url: (id) => `ws://x/${id}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 42,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'nothing.here',
				input: null,
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec); // MESSAGE_TYPE.RPC
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.requestId).toBe(42);
		expect(parsed.result.data).toBeNull();
		expect(isRpcError(parsed.result.error)).toBe(true);
		expect((parsed.result.error as { name: string }).name).toBe(
			'ActionNotFound',
		);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC request with dispatch config forwards to handler and Ok-wraps raw return value', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-dispatch' });
		const calls: Array<{ action: string; input: unknown }> = [];
		const sync = attachSync(ydoc, {
			url: (id) => `ws://x/${id}`,
			rpc: {
				// Return a raw value — attachSync's handler is responsible for
				// normalizing it into a `{data, error}` envelope on the wire.
				dispatch: async (action, input) => {
					calls.push({ action, input });
					return { echo: input, action };
				},
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 7,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'tabs.close',
				input: { tabIds: [1, 2] },
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		expect(calls).toEqual([
			{ action: 'tabs.close', input: { tabIds: [1, 2] } },
		]);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.requestId).toBe(7);
		expect(parsed.result).toEqual({
			data: { echo: { tabIds: [1, 2] }, action: 'tabs.close' },
			error: null,
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC with dispatch returning a Result passes the envelope through untouched', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-result-passthrough' });
		const sync = attachSync(ydoc, {
			url: (id) => `ws://x/${id}`,
			rpc: {
				// Handler returns an Err directly; attachSync must not re-wrap it.
				dispatch: async () => ({
					data: null,
					error: { name: 'BrowserApiFailed', message: 'no tab 999' },
				}),
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 11,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'tabs.close',
				input: { tabIds: [999] },
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		// The typed error survives on the wire — the handler's own Err shape
		// reaches the remote caller, not a wrapped RpcError.
		expect(parsed.result.data).toBeNull();
		expect(parsed.result.error).toEqual({
			name: 'BrowserApiFailed',
			message: 'no tab 999',
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC with dispatch that throws responds with RpcError.ActionFailed carrying the cause', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-throw' });
		const sync = attachSync(ydoc, {
			url: (id) => `ws://x/${id}`,
			rpc: {
				dispatch: async () => {
					throw new Error('handler exploded');
				},
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 12,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'tabs.close',
				input: null,
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.result.data).toBeNull();
		expect(isRpcError(parsed.result.error)).toBe(true);
		const err = parsed.result.error as { name: string; action: string };
		expect(err.name).toBe('ActionFailed');
		expect(err.action).toBe('tabs.close');

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('fresh connection resets version counters — prior unacked writes do not leak state', async () => {
		const ydoc = new Y.Doc({ guid: 'test-doc-3' });
		const sync = attachSync(ydoc, { url: (id) => `ws://x/${id}` });

		const firstWs = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => firstWs.readyState === FakeWebSocket.OPEN);
		firstWs.deliver(serverStep2Frame());
		await sync.whenConnected;

		// Mutate without letting the probe echo back; drop the connection.
		ydoc.getMap('m').set('k', 'v');
		firstWs.close();

		const secondWs = await waitFor(
			() => FakeWebSocket.instances[1],
			3000,
		);
		await waitFor(() => secondWs.readyState === FakeWebSocket.OPEN);
		secondWs.deliver(serverStep2Frame());

		await waitFor(
			() =>
				sync.status.phase === 'connected' && !sync.status.hasLocalChanges,
		);

		ydoc.destroy();
		await sync.whenDisposed;
	});
});

