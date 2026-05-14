/**
 * Tests for the peer surface.
 *
 * Exercises `createPeersSurface` and `waitForPeer` with mock send hooks plus
 * direct awareness-state injection (no WebSocket, no real RPC).
 *
 * Covers spec Phase 2.1 / 2.3:
 *   - list() excludes self by clientID and by identity.id
 *   - list() drops malformed states; sorts by clientId
 *   - find() returns undefined when absent; lowest clientId on identity collision
 *   - peer.invoke routes through hooks.sendActionRequest and surfaces PeerLeft
 *   - peer.describe routes through hooks.sendRuntimeRequest with the
 *     'describe-actions' runtime verb
 *   - waitForPeer initial / awareness-change / timeout / non-positive timeout
 */

import { describe, expect, test } from 'bun:test';
import { RpcError } from '@epicenter/sync';
import { Ok, type Result } from 'wellcrafted/result';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
	createPeersSurface,
	type PeerWireHooks,
	waitForPeer,
} from './peer.js';

function setup({
	selfClientId = 1,
	selfReplicaId = 'self',
	send,
	sendRuntime,
	peerMetadata,
}: {
	selfClientId?: number;
	selfReplicaId?: string;
	send?: PeerWireHooks['sendActionRequest'];
	sendRuntime?: PeerWireHooks['sendRuntimeRequest'];
	peerMetadata?: Map<number, { subject: string }>;
} = {}) {
	// Yjs accepts `clientID` at runtime but it isn't on `DocOpts`. The cast
	// is test-only: production code never sets a deterministic clientID.
	const ydoc = new Y.Doc({ clientID: selfClientId } as ConstructorParameters<typeof Y.Doc>[0]);
	const awareness = new Awareness(ydoc);
	const hooks: PeerWireHooks = {
		sendActionRequest: send ?? (async () => Ok(null)),
		sendRuntimeRequest: sendRuntime ?? (async () => Ok(null)),
	};
	const metadata = peerMetadata ?? new Map<number, { subject: string }>();
	const peers = createPeersSurface(awareness, metadata, selfReplicaId, hooks);
	return { ydoc, awareness, peers, peerMetadata: metadata };
}

function publish(
	awareness: Awareness,
	clientId: number,
	state: Record<string, unknown>,
) {
	awareness.getStates().set(clientId, state);
}

function validPeerState(replicaId: string, actionKeys: string[] = []) {
	return {
		replica: { id: replicaId, platform: 'node' as const },
		actionKeys,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// createPeersSurface — list / find filters
// ════════════════════════════════════════════════════════════════════════════

describe('createPeersSurface.list', () => {
	test('excludes self by transport clientID', () => {
		const { awareness, peers } = setup({ selfClientId: 1 });
		publish(awareness, awareness.clientID, validPeerState('self'));
		publish(awareness, 2, validPeerState('mac'));

		expect(peers.list().map((p) => p.replica.id)).toEqual(['mac']);
	});

	test('excludes stale self entry by replica.id even when clientId differs', () => {
		const { awareness, peers } = setup({ selfReplicaId: 'self' });
		publish(awareness, 99, validPeerState('self'));
		publish(awareness, 100, validPeerState('mac'));

		expect(peers.list().map((p) => p.replica.id)).toEqual(['mac']);
	});

	test('drops state with missing replica', () => {
		const { awareness, peers } = setup();
		publish(awareness, 10, { actionKeys: [] });

		expect(peers.list()).toEqual([]);
	});

	test('drops state with malformed actionKeys', () => {
		const { awareness, peers } = setup();
		publish(awareness, 10, {
			replica: { id: 'mac', platform: 'node' },
			actionKeys: 'not-an-array',
		});

		expect(peers.list()).toEqual([]);
	});

	test('drops non-object state', () => {
		const { awareness, peers } = setup();
		// Awareness state map types values as records, but the readers must
		// tolerate null entries; injecting null here exercises that guard.
		(awareness.getStates() as Map<number, unknown>).set(10, null);

		expect(peers.list()).toEqual([]);
	});

	test('sorts by clientID ascending', () => {
		const { awareness, peers } = setup();
		publish(awareness, 30, validPeerState('c'));
		publish(awareness, 10, validPeerState('a'));
		publish(awareness, 20, validPeerState('b'));

		expect(peers.list().map((p) => p.clientID)).toEqual([10, 20, 30]);
	});

	test('peer.actionKeys surfaces from awareness', () => {
		const { awareness, peers } = setup();
		publish(awareness, 10, validPeerState('mac', ['tabs_close', 'tabs_list']));

		const list = peers.list();
		expect(list[0]?.actionKeys).toEqual(['tabs_close', 'tabs_list']);
	});
});

describe('createPeersSurface.find', () => {
	test('returns matching peer by replica.id', () => {
		const { awareness, peers } = setup();
		publish(awareness, 10, validPeerState('mac'));

		expect(peers.find('mac')?.clientID).toBe(10);
	});

	test('returns undefined for unknown peer', () => {
		const { peers } = setup();
		expect(peers.find('nobody')).toBeUndefined();
	});

	test('returns lowest clientId when multiple peers share a replica.id', () => {
		const { awareness, peers } = setup();
		publish(awareness, 30, validPeerState('dup'));
		publish(awareness, 10, validPeerState('dup'));
		publish(awareness, 20, validPeerState('dup'));

		expect(peers.find('dup')?.clientID).toBe(10);
	});

	test('peer.subject is joined from the supervisor peerMetadata map', () => {
		const peerMetadata = new Map<number, { subject: string }>([
			[10, { subject: 'user_alice' }],
		]);
		const { awareness, peers } = setup({ peerMetadata });
		publish(awareness, 10, validPeerState('mac'));

		const peer = peers.find('mac');
		expect(peer?.subject).toBe('user_alice');
	});

	test('peer.subject falls back to empty string when no envelope has arrived', () => {
		const { awareness, peers } = setup();
		publish(awareness, 10, validPeerState('mac'));

		const peer = peers.find('mac');
		expect(peer?.subject).toBe('');
	});
});

describe('createPeersSurface.observe', () => {
	test('fires on awareness change, returns unsubscribe', () => {
		const { awareness, peers } = setup();
		let calls = 0;

		const unobserve = peers.observe(() => {
			calls++;
		});

		awareness.setLocalState({ tick: 1 });
		expect(calls).toBe(1);

		unobserve();
		awareness.setLocalState({ tick: 2 });
		expect(calls).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// peer.invoke / peer.describe dispatch
// ════════════════════════════════════════════════════════════════════════════

describe('peer.invoke', () => {
	test('passes target clientId, action, input, options to sendActionRequest', async () => {
		let captured: {
			target?: number;
			action?: string;
			input?: unknown;
			options?: { timeout?: number };
		} = {};
		const { awareness, peers } = setup({
			send: async (target, action, input, options) => {
				captured = { target, action, input, options };
				return Ok({ closedCount: 1 });
			},
		});
		publish(awareness, 42, validPeerState('mac'));

		const peer = peers.find('mac');
		const result = await peer?.invoke(
			'tabs_close',
			{ tabIds: [1] },
			{ timeout: 100 },
		);

		expect(captured.target).toBe(42);
		expect(captured.action).toBe('tabs_close');
		expect(captured.input).toEqual({ tabIds: [1] });
		expect(captured.options).toEqual({ timeout: 100 });
		expect(result?.data).toEqual({ closedCount: 1 });
		expect(result?.error).toBeNull();
	});

	test('peers.find returns undefined when the peer is not in awareness', () => {
		const { peers } = setup();
		expect(peers.find('ghost')).toBeUndefined();
	});

	test('returns PeerLeft when peer disappears mid-call', async () => {
		let resolveSend!: (value: Result<unknown, RpcError>) => void;
		const sendPromise = new Promise<Result<unknown, RpcError>>((resolve) => {
			resolveSend = resolve;
		});

		const { awareness, peers } = setup({
			send: () => sendPromise,
		});
		publish(awareness, 42, validPeerState('mac'));

		const peer = peers.find('mac')!;
		const invocation = peer.invoke('tabs_close', { tabIds: [1] });

		// Peer leaves before sendActionRequest resolves.
		awareness.getStates().delete(42);
		awareness.emit('change', [
			{ added: [], updated: [], removed: [42] },
			'test',
		]);

		const result = await invocation;
		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('PeerLeft');
		if (result.error?.name === 'PeerLeft') {
			expect(result.error.peerId).toBe('mac');
			expect(result.error.action).toBe('tabs_close');
		}

		// Resolve the dangling send so the test process doesn't leak.
		resolveSend(Ok(null));
	});

	test('wraps thrown sendActionRequest errors in RpcError.ActionFailed', async () => {
		const { awareness, peers } = setup({
			send: () => Promise.reject(new Error('boom')),
		});
		publish(awareness, 42, validPeerState('mac'));

		const peer = peers.find('mac')!;
		const result = await peer.invoke('tabs_close', { tabIds: [1] });

		expect(result.error?.name).toBe('ActionFailed');
		if (result.error?.name === 'ActionFailed') {
			expect(result.error.action).toBe('tabs_close');
			expect((result.error.cause as Error).message).toBe('boom');
		}
	});
});

describe('peer.describe', () => {
	test('dispatches the describe-actions runtime verb (not via sendActionRequest)', async () => {
		let actionCalls = 0;
		let dispatchedVerb = '';
		let dispatchedTarget = 0;
		const { awareness, peers } = setup({
			send: async () => {
				actionCalls++;
				return Ok(null);
			},
			sendRuntime: async (target, verb) => {
				dispatchedTarget = target;
				dispatchedVerb = verb;
				return Ok({ tabs_close: { type: 'mutation' } });
			},
		});
		publish(awareness, 42, validPeerState('mac'));

		const result = await peers.find('mac')?.describe();
		expect(dispatchedVerb).toBe('describe-actions');
		expect(dispatchedTarget).toBe(42);
		expect(actionCalls).toBe(0);
		expect(result?.error).toBeNull();
		expect(result?.data).toEqual({ tabs_close: { type: 'mutation' } });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// waitForPeer
// ════════════════════════════════════════════════════════════════════════════

describe('waitForPeer', () => {
	test('returns existing peer synchronously wrapped in a promise', async () => {
		const { awareness, peers } = setup();
		publish(awareness, 42, validPeerState('mac'));

		const peer = await waitForPeer(peers, 'mac', { timeoutMs: 1000 });
		expect(peer?.replica.id).toBe('mac');
	});

	test('resolves when peer arrives via awareness change', async () => {
		const { awareness, peers } = setup();

		const pending = waitForPeer(peers, 'mac', { timeoutMs: 1000 });

		// Simulate peer join.
		publish(awareness, 42, validPeerState('mac'));
		awareness.emit('change', [
			{ added: [42], updated: [], removed: [] },
			'test',
		]);

		const peer = await pending;
		expect(peer?.replica.id).toBe('mac');
	});

	test('resolves undefined on timeout', async () => {
		const { peers } = setup();

		const peer = await waitForPeer(peers, 'mac', { timeoutMs: 10 });
		expect(peer).toBeUndefined();
	});

	test('timeoutMs <= 0 returns undefined immediately when peer absent', async () => {
		const { peers } = setup();

		const peer = await waitForPeer(peers, 'mac', { timeoutMs: 0 });
		expect(peer).toBeUndefined();
	});

	test('peer present + non-positive timeout still resolves with the peer', async () => {
		const { awareness, peers } = setup();
		publish(awareness, 42, validPeerState('mac'));

		const peer = await waitForPeer(peers, 'mac', { timeoutMs: 0 });
		expect(peer?.replica.id).toBe('mac');
	});
});
