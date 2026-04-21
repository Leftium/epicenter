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
	encodeSyncStatus,
	encodeSyncStep2,
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

	constructor(public readonly url: string) {
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

