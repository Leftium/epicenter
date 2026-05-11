/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	BC_ORIGIN,
	BEARER_SUBPROTOCOL_PREFIX,
	decodeRpcPayload,
	encodeAwarenessStates,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStep2,
	MAIN_SUBPROTOCOL,
	MESSAGE_TYPE,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import Type from 'typebox';
import { Ok } from 'wellcrafted/result';
import * as Y from 'yjs';
import { defineMutation } from '../shared/actions.js';
import { attachAwareness } from './attach-awareness.js';
import { attachSync, type OpenWebSocket } from './attach-sync.js';
import { PeerIdentity } from './peer-identity.js';

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readonly bufferedAmount = 0;
	readonly extensions = '';
	readonly protocol: string;
	readonly url: string;
	readyState = FakeWebSocket.CONNECTING;
	binaryType: 'arraybuffer' | 'blob' = 'blob';
	onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
	onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
	onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
	onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
	readonly sent: Uint8Array[] = [];

	constructor(
		url: string,
		public readonly protocols?: string | string[],
	) {
		this.url = url;
		this.protocol = Array.isArray(protocols)
			? (protocols[0] ?? '')
			: (protocols ?? '');
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.onopen?.call(this, new Event('open'));
		});
	}

	send(data: Uint8Array | string) {
		if (typeof data !== 'string') this.sent.push(new Uint8Array(data));
	}

	close(code?: number, reason?: string) {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.call(this, {
			code: code ?? 1005,
			reason: reason ?? '',
		} as CloseEvent);
	}

	addEventListener() {}
	removeEventListener() {}
	dispatchEvent() {
		return true;
	}

	deliver(frame: Uint8Array) {
		this.onmessage?.call(this, {
			data: frame.buffer.slice(
				frame.byteOffset,
				frame.byteOffset + frame.byteLength,
			) as ArrayBuffer,
		} as MessageEvent);
	}
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
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

function openWithBearerToken(token: string): OpenWebSocket {
	return (url, protocols = []) =>
		new WebSocket(url, [...protocols, `${BEARER_SUBPROTOCOL_PREFIX}${token}`]);
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

describe('attachSync split surface', () => {
	test('opener receives sync URL and main protocol', async () => {
		const ydoc = new Y.Doc({ guid: 'split-opener-protocol' });
		const calls: { url: string | URL; protocols?: string[] }[] = [];
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: (url, protocols) => {
				calls.push({ url, protocols });
				return new WebSocket(url, protocols);
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		expect(calls).toEqual([
			{ url: `ws://x/${ydoc.guid}`, protocols: [MAIN_SUBPROTOCOL] },
		]);
		expect(ws.protocols).toEqual([MAIN_SUBPROTOCOL]);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('auth-owned opener can append bearer subprotocol', async () => {
		const ydoc = new Y.Doc({ guid: 'split-bearer-protocol' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: openWithBearerToken('test-token'),
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		expect(ws.protocols).toEqual([
			MAIN_SUBPROTOCOL,
			`${BEARER_SUBPROTOCOL_PREFIX}test-token`,
		]);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('default opener constructs websocket with only main protocol', async () => {
		const ydoc = new Y.Doc({ guid: 'split-default-protocol' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		expect(ws.protocols).toEqual([MAIN_SUBPROTOCOL]);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('opener runs again for reconnect attempts', async () => {
		const ydoc = new Y.Doc({ guid: 'split-reconnect-opener' });
		const calls: string[] = [];
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: (url, protocols) => {
				calls.push(String(url));
				return new WebSocket(url, protocols);
			},
		});

		await waitFor(() => FakeWebSocket.instances[0]);
		sync.reconnect();

		await waitFor(() => (calls.length === 2 ? calls.join(',') : undefined));
		expect(calls).toEqual([`ws://x/${ydoc.guid}`, `ws://x/${ydoc.guid}`]);
		expect(FakeWebSocket.instances).toHaveLength(2);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('opener failure retries through existing backoff', async () => {
		const ydoc = new Y.Doc({ guid: 'split-opener-retry' });
		let calls = 0;
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: (url, protocols) => {
				calls += 1;
				if (calls === 1) throw new Error('socket unavailable');
				return new WebSocket(url, protocols);
			},
		});

		await waitFor(() => (calls >= 2 ? calls : undefined), 1500);
		expect(calls).toBe(2);
		expect(FakeWebSocket.instances).toHaveLength(1);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('close 4401 enters failed auth status', async () => {
		const ydoc = new Y.Doc({ guid: 'split-auth-failed' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		ws.close(4401, JSON.stringify({ code: 'token_expired' }));

		const status = await waitFor(() =>
			sync.status.phase === 'failed' ? sync.status : undefined,
		);
		expect(status).toEqual({
			phase: 'failed',
			reason: { type: 'auth', code: 'token_expired' },
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('reconnect clears failed auth phase for same-user reauth', async () => {
		const ydoc = new Y.Doc({ guid: 'split-auth-reauth' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
		});

		const firstWs = await waitFor(() => FakeWebSocket.instances[0]);
		firstWs.close(4401, JSON.stringify({ code: 'token_expired' }));
		await waitFor(() =>
			sync.status.phase === 'failed' ? sync.status : undefined,
		);

		sync.reconnect();
		const secondWs = await waitFor(() => FakeWebSocket.instances[1]);
		await waitFor(() => secondWs.readyState === FakeWebSocket.OPEN);
		secondWs.deliver(serverStep2Frame());

		await waitFor(() =>
			sync.status.phase === 'connected' ? sync.status : undefined,
		);
		expect(sync.status).toEqual({ phase: 'connected' });

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('sync owns lifecycle and connected status', async () => {
		const ydoc = new Y.Doc({ guid: 'split-sync' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: openWithBearerToken('test-token'),
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		expect(sync.status).toEqual({ phase: 'connected' });
		expect('rpc' in sync).toBe(false);
		expect('peers' in sync).toBe(false);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('does not forward broadcast-channel-origin updates to the server', async () => {
		const ydoc = new Y.Doc({ guid: 'split-bc-origin' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: openWithBearerToken('test-token'),
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const sentBeforeBroadcastOrigin = ws.sent.length;
		ydoc.transact(() => {
			ydoc.getText('body').insert(0, 'from bc');
		}, BC_ORIGIN);
		expect(ws.sent).toHaveLength(sentBeforeBroadcastOrigin);

		ydoc.transact(() => {
			ydoc.getText('body').insert(0, 'local ');
		});
		expect(ws.sent).toHaveLength(sentBeforeBroadcastOrigin + 1);

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
			openWebSocket: openWithBearerToken('test-token'),
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
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: openWithBearerToken('test-token'),
		});
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
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			openWebSocket: openWithBearerToken('test-token'),
		});

		expect(() =>
			sync.attachRpc({
				system: {},
			}),
		).toThrow(/system/);

		ydoc.destroy();
	});
});
