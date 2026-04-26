/**
 * `peer<T>()` unit tests — proxy mechanics + first-match resolution +
 * disconnect short-circuit. Tests use a mock `Peers` and mock `sync.rpc` —
 * no real Y.Doc, no real awareness. The peer-resolution logic itself is
 * covered in `attach-peers.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import Type from 'typebox';
import { Err, Ok, isErr } from 'wellcrafted/result';
import type { Result } from 'wellcrafted/result';
import { RpcError, isRpcError } from '@epicenter/sync';
import type { FoundPeer } from '../document/attach-peers.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { peer, type PeerWorkspace } from './peer.js';

// Reference action shape used to type the test proxy. Handlers are never
// invoked here — only the *type* flows through `peer<typeof TestActions>`.
const TestActions = {
	tabs: {
		close: defineMutation({
			input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
			handler: (_input): { closedCount: number } => ({ closedCount: 0 }),
		}),
	},
	foo: {
		bar: defineMutation({
			input: Type.Object({}),
			handler: (): unknown => undefined,
		}),
	},
	x: defineQuery({ handler: (): unknown => undefined }),
};
type TestActions = typeof TestActions;

type RpcCall = {
	target: number;
	action: string;
	input?: unknown;
	options?: { timeout?: number };
};

/**
 * Mock `Peers` keyed on a mutable `present` map; tests can drop a peer
 * mid-call by mutating the map and invoking the captured observer.
 */
function mockPeers(initial: Record<string, number>) {
	const present = new Map(Object.entries(initial));
	const observers = new Set<() => void>();
	return {
		find(deviceId: string): FoundPeer | undefined {
			const clientId = present.get(deviceId);
			if (clientId === undefined) return undefined;
			return {
				clientId,
				state: {
					device: {
						id: deviceId,
						name: deviceId,
						platform: 'web',
						offers: {},
					},
				},
			};
		},
		observe(cb: () => void) {
			observers.add(cb);
			return () => observers.delete(cb);
		},
		drop(deviceId: string) {
			present.delete(deviceId);
			for (const cb of observers) cb();
		},
	};
}

function mockWorkspace(opts: {
	peers: ReturnType<typeof mockPeers>;
	respond: (call: RpcCall) => Promise<Result<unknown, RpcError>>;
	calls?: RpcCall[];
}): PeerWorkspace {
	const calls = opts.calls ?? [];
	return {
		peers: opts.peers,
		sync: {
			async rpc(target, action, input, options) {
				const call = { target, action, input, options };
				calls.push(call);
				return opts.respond(call);
			},
		},
	};
}

describe('peer<T>()', () => {
	it('builds a proxy whose dot-path becomes the rpc action arg', async () => {
		const peers = mockPeers({ mac: 42 });
		const calls: RpcCall[] = [];
		const ws = mockWorkspace({
			peers,
			calls,
			respond: async () => Ok({ closedCount: 1 }),
		});

		const remote = peer<TestActions>(ws, 'mac');
		const result = await remote.tabs.close({ tabIds: [1] }, { timeout: 1000 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('tabs.close');
		expect(calls[0]?.input).toEqual({ tabIds: [1] });
		expect(calls[0]?.options).toEqual({ timeout: 1000 });
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 1 });
	});

	it('returns Err(PeerNotFound) without sending when peer is absent', async () => {
		const peers = mockPeers({});
		const calls: RpcCall[] = [];
		const ws = mockWorkspace({
			peers,
			calls,
			respond: async () => {
				throw new Error('rpc should not be called');
			},
		});

		const remote = peer<TestActions>(ws, 'ghost');
		const result = await remote.foo.bar({});
		expect(calls).toHaveLength(0);
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerNotFound');
		}
	});

	it('passes a Result through unchanged when the peer returns one', async () => {
		const peers = mockPeers({ mac: 1 });
		const ws = mockWorkspace({
			peers,
			respond: async () => Err(RpcError.ActionNotFound({ action: 'x' }).error),
		});

		const remote = peer<TestActions>(ws, 'mac');
		const result = await remote.x();
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('ActionNotFound');
		}
	});

	it('rejects with PeerLeft when the peer drops mid-call', async () => {
		const peers = mockPeers({ mac: 7 });
		// Hold the rpc response forever so the disconnect can race ahead.
		const ws = mockWorkspace({
			peers,
			respond: () => new Promise<Result<unknown, RpcError>>(() => {}),
		});

		const remote = peer<TestActions>(ws, 'mac');
		const callPromise = remote.tabs.close({ tabIds: [1] });

		peers.drop('mac');

		const result = await callPromise;
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerLeft');
		}
	});
});
