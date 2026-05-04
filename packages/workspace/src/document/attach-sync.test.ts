/// <reference lib="dom" />

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthClient, AuthSnapshot } from '@epicenter/auth';
import {
	decodeRpcPayload,
	encodeAwarenessStates,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStep2,
	MESSAGE_TYPE,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import Type from 'typebox';
import { Ok } from 'wellcrafted/result';
import * as Y from 'yjs';
import { defineMutation } from '../shared/actions.js';
import { attachAwareness } from './attach-awareness.js';
import { attachSync } from './attach-sync.js';
import { PeerIdentity } from './peer-identity.js';

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
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: Listener | null = null;
	readonly sent: Uint8Array[] = [];

	constructor(
		public readonly url: string,
		public readonly protocols?: string | string[],
	) {
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.onopen?.();
		});
	}

	send(data: Uint8Array | string) {
		if (typeof data !== 'string') this.sent.push(new Uint8Array(data));
	}

	close(code?: number, reason?: string) {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
	}

	addEventListener() {}
	removeEventListener() {}

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

function peekMessageType(frame: Uint8Array): number {
	return decoding.readVarUint(decoding.createDecoder(frame));
}

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

function signedInSnapshot(token: string): AuthSnapshot {
	return {
		status: 'signedIn',
		session: {
			token,
			user: {
				id: 'user-1',
				createdAt: '2026-05-03T00:00:00.000Z',
				updatedAt: '2026-05-03T00:00:00.000Z',
				email: 'test@example.com',
				emailVerified: true,
				name: 'Test User',
			},
			encryptionKeys: [{ version: 1, userKeyBase64: 'key' }],
		},
	};
}

function createAuthClient(initialSnapshot: AuthSnapshot) {
	let snapshot = initialSnapshot;
	const listeners = new Set<(snapshot: AuthSnapshot) => void>();
	const calls: string[] = [];
	const auth = {
		get snapshot() {
			calls.push(`snapshot:${snapshot.status}`);
			return snapshot;
		},
		whenLoaded: Promise.resolve(),
		onSnapshotChange(listener) {
			listeners.add(listener);
			return () => {
				calls.push('unsubscribe');
				listeners.delete(listener);
			};
		},
		async signIn() {
			return Ok(undefined);
		},
		async signUp() {
			return Ok(undefined);
		},
		async signInWithSocialPopup() {
			return Ok(undefined);
		},
		async signInWithSocialRedirect() {
			return Ok(undefined);
		},
		async signOut() {
			return Ok(undefined);
		},
		fetch: globalThis.fetch.bind(globalThis),
		[Symbol.dispose]() {},
	} satisfies AuthClient;

	return {
		auth,
		calls,
		setSnapshot(nextSnapshot: AuthSnapshot) {
			snapshot = nextSnapshot;
			for (const listener of listeners) listener(nextSnapshot);
		},
	};
}

describe('attachSync split surface', () => {
	test('sync owns lifecycle and connected status', async () => {
		const ydoc = new Y.Doc({ guid: 'split-sync' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		expect(sync.status).toEqual({
			phase: 'connected',
			hasLocalChanges: false,
		});
		expect('rpc' in sync).toBe(false);
		expect('peers' in sync).toBe(false);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('transports provided awareness', async () => {
		const ydoc = new Y.Doc({ guid: 'split-presence' });
		const awareness = attachAwareness(ydoc, {
			schema: { peer: PeerIdentity },
			initial: { peer: { id: 'mac', name: 'Mac', platform: 'web' } },
		});
		attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			awareness,
		});

		expect(awareness.raw.getLocalState()).toEqual({
			peer: { id: 'mac', name: 'Mac', platform: 'web' },
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		await waitFor(() =>
			ws.sent.some(
				(frame) => peekMessageType(frame) === MESSAGE_TYPE.AWARENESS,
			),
		);

		const remoteDoc = new Y.Doc();
		const remoteAwareness = attachAwareness(remoteDoc, {
			schema: { peer: PeerIdentity },
			initial: { peer: { id: 'phone', name: 'Phone', platform: 'web' } },
		});
		ws.deliver(
			encodeAwarenessStates({
				awareness: remoteAwareness.raw,
				clients: [remoteDoc.clientID],
			}),
		);

		const peers = awareness.peers();
		const found = [...peers.values()].find(
			(state) => state.peer.id === 'phone',
		);
		expect(found?.peer.id).toBe('phone');
		expect(
			[...peers.values()].find((state) => state.peer.id === 'ghost'),
		).toBeUndefined();

		ws.close();
		await waitFor(() => awareness.peers().size === 0);

		ydoc.destroy();
		remoteDoc.destroy();
	});

	test('attachRpc dispatches inbound actions and returns outbound responses', async () => {
		const ydoc = new Y.Doc({ guid: 'split-rpc' });
		const calls: unknown[] = [];
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });
		const rpc = sync.attachRpc({
			tabs: {
				close: defineMutation({
					input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
					handler: (input) => {
						calls.push(input);
						return { closedCount: input.tabIds.length };
					},
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
		});
		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.result).toEqual(Ok({ closedCount: 2 }));
		expect(calls).toEqual([{ tabIds: [1, 2] }]);

		const outboundSeenBefore = ws.sent.length;
		const outbound = rpc.rpc(12345, 'tabs.close', { tabIds: [1] });
		const requestFrame = await waitFor<Uint8Array>(() => {
			for (let i = outboundSeenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		});
		const requestDec = decoding.createDecoder(requestFrame);
		decoding.readVarUint(requestDec);
		const request = decodeRpcPayload(requestDec);
		if (request.type !== 'request') throw new Error('expected request');
		ws.deliver(
			encodeRpcResponse({
				requestId: request.requestId,
				requesterClientId: ydoc.clientID,
				result: Ok({ closedCount: 1 }),
			}),
		);
		const result = await outbound;
		expect(result).toEqual(Ok({ closedCount: 1 }));

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('attachRpc reserves system namespace', () => {
		const ydoc = new Y.Doc({ guid: 'split-system-reserved' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		expect(() =>
			sync.attachRpc({
				system: {},
			}),
		).toThrow(/system/);

		ydoc.destroy();
	});

	test('auth token changes reconnect the active socket', async () => {
		const ydoc = new Y.Doc({ guid: 'auth-reconnect' });
		const auth = createAuthClient(signedInSnapshot('token-1'));
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			auth: auth.auth,
		});

		const first = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => first.readyState === FakeWebSocket.OPEN);
		first.deliver(serverStep2Frame());
		await sync.whenConnected;

		auth.setSnapshot(signedInSnapshot('token-2'));
		const second = await waitFor(() => FakeWebSocket.instances[1]);
		await waitFor(() => second.readyState === FakeWebSocket.OPEN);

		expect(first.readyState).toBe(FakeWebSocket.CLOSED);
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(first.protocols).toEqual(['epicenter', 'bearer.token-1']);
		expect(second.protocols).toEqual(['epicenter', 'bearer.token-2']);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('auth snapshot subscription unsubscribes on destroy', async () => {
		const ydoc = new Y.Doc({ guid: 'auth-destroy' });
		const auth = createAuthClient(signedInSnapshot('token-1'));
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			auth: auth.auth,
		});

		await waitFor(() => FakeWebSocket.instances[0]);
		ydoc.destroy();
		await sync.whenDisposed;

		expect(auth.calls).toContain('unsubscribe');
	});

	test('auth token changes before waitFor do not bypass startup gating', async () => {
		const { promise: whenLoaded, resolve } = Promise.withResolvers<void>();
		const ydoc = new Y.Doc({ guid: 'auth-wait-for' });
		const auth = createAuthClient(signedInSnapshot('token-1'));
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			waitFor: whenLoaded,
			auth: auth.auth,
		});

		auth.setSnapshot(signedInSnapshot('token-2'));
		await Promise.resolve();
		expect(FakeWebSocket.instances).toHaveLength(0);

		resolve();
		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);

		expect(ws.protocols).toEqual(['epicenter', 'bearer.token-2']);

		ydoc.destroy();
		await sync.whenDisposed;
	});
});
