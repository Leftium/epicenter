import { describe, expect, test } from 'bun:test';
import { isRpcError, RpcError } from '@epicenter/sync';
import Type from 'typebox';
import type { Result } from 'wellcrafted/result';
import { Err, isErr, Ok } from 'wellcrafted/result';
import type { SyncRpcAttachment } from '../document/attach-sync.js';
import type { PeerDirectory } from '../document/peer-presence.js';
import type { ResolvedPeer } from '../document/peer-presence-defs.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import {
	createRemoteClient,
	type RemoteClientOptions,
} from './remote-actions.js';

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

function mockRemoteOptions({
	present: presentPeers,
	respond,
	calls = [],
}: {
	present: Record<string, number>;
	respond: (call: RpcCall) => Promise<Result<unknown, RpcError>>;
	calls?: RpcCall[];
}): RemoteClientOptions & { drop(peerId: string): void } {
	const present = new Map(Object.entries(presentPeers));
	const observers = new Set<() => void>();

	const peerDirectory: PeerDirectory = {
		peers: () => new Map(),
		find(peerId): ResolvedPeer | undefined {
			const clientId = present.get(peerId);
			if (clientId === undefined) return undefined;
			return {
				clientId,
				state: {
					peer: {
						id: peerId,
						name: peerId,
						platform: 'web',
					},
				},
			};
		},
		waitForPeer: async () => {
			throw new Error('waitForPeer should not be called');
		},
		observe(callback) {
			observers.add(callback);
			return () => observers.delete(callback);
		},
	};

	const rpc: SyncRpcAttachment = {
		async rpc(target, action, input, options) {
			const call = { target, action, input, options };
			calls.push(call);
			return respond(call);
		},
	};

	return {
		peerDirectory,
		rpc,
		drop(peerId: string) {
			present.delete(peerId);
			for (const callback of observers) callback();
		},
	};
}

describe('createRemoteClient actions', () => {
	test('builds a proxy whose dot-path becomes the rpc action arg', async () => {
		const calls: RpcCall[] = [];
		const options = mockRemoteOptions({
			present: { mac: 42 },
			calls,
			respond: async () => Ok({ closedCount: 1 }),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const result = await remote.tabs.close({ tabIds: [1] }, { timeout: 1000 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('tabs.close');
		expect(calls[0]?.input).toEqual({ tabIds: [1] });
		expect(calls[0]?.options).toEqual({ timeout: 1000 });
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 1 });
	});

	test('returns Err(PeerNotFound) without sending when peer is absent', async () => {
		const calls: RpcCall[] = [];
		const options = mockRemoteOptions({
			present: {},
			calls,
			respond: async () => {
				throw new Error('rpc should not be called');
			},
		});

		const remote = createRemoteClient(options).actions<TestActions>('ghost');
		const result = await remote.foo.bar({});

		expect(calls).toHaveLength(0);
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerNotFound');
		}
	});

	test('passes a Result through unchanged when the peer returns one', async () => {
		const options = mockRemoteOptions({
			present: { mac: 1 },
			respond: async () => Err(RpcError.ActionNotFound({ action: 'x' }).error),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const result = await remote.x();

		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('ActionNotFound');
		}
	});

	test('resolves with PeerLeft when the peer drops mid-call', async () => {
		const options = mockRemoteOptions({
			present: { mac: 7 },
			respond: () => new Promise<Result<unknown, RpcError>>(() => {}),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const callPromise = remote.tabs.close({ tabIds: [1] });

		options.drop('mac');

		const result = await callPromise;
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerLeft');
		}
	});
});

describe('createRemoteClient', () => {
	test('binds peer directory and rpc so callers only pass the peer target', async () => {
		const calls: RpcCall[] = [];
		const options = mockRemoteOptions({
			present: { mac: 42 },
			calls,
			respond: async () => Ok({ closedCount: 1 }),
		});

		const remote = createRemoteClient(options);
		const result = await remote
			.actions<TestActions>('mac')
			.tabs.close({ tabIds: [1] });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('tabs.close');
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 1 });
	});

	test('describes a peer through the bound system action', async () => {
		const manifest = {
			'tabs.close': {
				type: 'mutation' as const,
				input: TestActions.tabs.close.input,
			},
		};
		const calls: RpcCall[] = [];
		const options = mockRemoteOptions({
			present: { mac: 42 },
			calls,
			respond: async () => Ok(manifest),
		});

		const remote = createRemoteClient(options);
		const result = await remote.describe('mac');

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('system.describe');
		expect(result.error).toBeNull();
		expect(result.data).toEqual(manifest);
	});
});
