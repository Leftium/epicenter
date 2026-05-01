/**
 * executeRun peer dispatch tests.
 *
 * Verifies the daemon normalizes peer lookup misses into the
 * `/run` error union before the response crosses the IPC boundary.
 */

import { describe, expect, test } from 'bun:test';

import { PeerMiss, type SyncRpcAttachment } from '../document/attach-sync.js';
import type { PeerDirectory } from '../document/peer-presence.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { executeRun } from './run-handler.js';
import type { StartedDaemonRoute } from './types.js';

type Runtime = StartedDaemonRoute['runtime'];

function fakePeerDirectory(
	overrides: Partial<PeerDirectory> = {},
): PeerDirectory {
	return {
		peers: () => new Map(),
		find: () => undefined,
		waitForPeer: async (peerTarget, { timeoutMs }) =>
			PeerMiss.PeerMiss({
				peerTarget,
				sawPeers: false,
				waitMs: timeoutMs,
				emptyReason: null,
			}),
		observe: () => () => {},
		...overrides,
	} as PeerDirectory;
}

function fakeRpc(
	overrides: Partial<SyncRpcAttachment> = {},
): SyncRpcAttachment {
	return {
		rpc: async () => ({ data: null, error: null }),
		...overrides,
	} as SyncRpcAttachment;
}

function fakeSync(): Runtime['sync'] {
	return {
		whenConnected: Promise.resolve(),
		status: { phase: 'connected', hasLocalChanges: false },
		onStatusChange: () => () => {},
		goOffline() {},
		reconnect() {},
		whenDisposed: Promise.resolve(),
		attachRpc: () => fakeRpc(),
	} as Runtime['sync'];
}

function fakeRuntime(
	actions: Runtime['actions'],
	extra: Record<string, unknown> = {},
): Runtime {
	return {
		actions,
		sync: fakeSync(),
		peerDirectory: fakePeerDirectory(),
		rpc: fakeRpc(),
		async [Symbol.asyncDispose]() {},
		...extra,
	};
}

function fakeEntry(
	peerDirectory: Partial<PeerDirectory> = {},
	rpc: Partial<SyncRpcAttachment> = {},
): StartedDaemonRoute {
	const runtime = fakeRuntime(
		{
			tabs: {
				list: defineQuery({
					handler: () => [],
				}),
			},
		},
		{
			peerDirectory: fakePeerDirectory(peerDirectory),
			rpc: fakeRpc(rpc),
		},
	);

	return { route: 'demo', runtime };
}

describe('executeRun peer dispatch', () => {
	test('peer miss returns RunError.PeerMiss and skips rpc', async () => {
		let rpcCalls = 0;
		const entry = fakeEntry(
			{
				async waitForPeer(peerId, { timeoutMs }) {
					return PeerMiss.PeerMiss({
						peerTarget: peerId,
						sawPeers: true,
						waitMs: timeoutMs,
						emptyReason: null,
					});
				},
			},
			{
				async rpc() {
					rpcCalls++;
					throw new Error('rpc should not be called');
				},
			},
		);

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'ghost',
			waitMs: 25,
		});

		expect(rpcCalls).toBe(0);
		expect(result.error).not.toBeNull();
		if (result.error === null) throw new Error('expected PeerMiss');
		expect(result.error.name).toBe('PeerMiss');
		if (result.error.name !== 'PeerMiss') {
			throw new Error(`expected PeerMiss, got ${result.error.name}`);
		}
		expect(result.error.peerTarget).toBe('ghost');
		expect(result.error.sawPeers).toBe(true);
		expect(result.error.waitMs).toBe(25);
		expect(result.error.emptyReason).toBeNull();
	});

	test('remote dispatch sends only the inner action path', async () => {
		let rpcAction = '';
		const entry = fakeEntry(
			{
				async waitForPeer() {
					return {
						data: {
							clientId: 42,
							state: { peer: { id: 'mac', name: 'Mac', platform: 'node' } },
						},
						error: null,
					};
				},
			},
			{
				async rpc(_clientId, action) {
					rpcAction = action;
					return { data: [], error: null };
				},
			},
		);

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(rpcAction).toBe('tabs.list');
	});
});

describe('executeRun route-prefixed routing', () => {
	test('invokes action under the selected daemon route', async () => {
		const runtime = fakeRuntime({
			notes: {
				add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});
		const entry = {
			route: 'notes',
			runtime,
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ body: 'hello' });
	});

	test('ignores action leaves outside the canonical action root', async () => {
		const runtime = fakeRuntime(
			{},
			{
				notes: {
					add: defineMutation({
						handler: () => ({ body: 'hello' }),
					}),
				},
			},
		);
		const entry = {
			route: 'notes',
			runtime,
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error?.name).toBe('UsageError');
	});

	test('missing path suggests action-root-relative sibling', async () => {
		const runtime = fakeRuntime({
			notes: {
				add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});
		const entry = {
			route: 'notes',
			runtime,
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error?.name).toBe('UsageError');
		if (result.error?.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(result.error.suggestions).toEqual(['  notes.notes.add  (mutation)']);
	});

	test('unknown route returns available route suggestions', async () => {
		const result = await executeRun(
			[
				fakeEntry({}),
				{
					route: 'tasks',
					runtime: fakeRuntime({}),
				},
			],
			{
				actionPath: 'missing.actions.add',
				input: undefined,
				waitMs: 25,
			},
		);

		expect(result.error?.name).toBe('UsageError');
		if (result.error?.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(result.error.message).toBe(
			'No daemon route "missing". Available: demo, tasks',
		);
		expect(result.error.suggestions).toEqual(['  demo', '  tasks']);
	});
});
