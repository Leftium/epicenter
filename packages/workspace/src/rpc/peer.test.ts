/**
 * `peer<T>()` unit tests — proxy mechanics + first-match resolution +
 * disconnect short-circuit. Tests use minimal mock workspaces (no real
 * Y.Doc / sync). End-to-end coverage with two real workspaces lives in
 * `__tests__/peer-e2e.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import Type from 'typebox';
import { Awareness as YAwareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { Err, Ok, isErr } from 'wellcrafted/result';
import type { Result } from 'wellcrafted/result';
import { RpcError, isRpcError } from '@epicenter/sync';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { peer, resolvePeer, type PeerWorkspace } from './peer.js';

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

/** Build a mock workspace whose `sync.rpc` resolves with the supplied responder. */
function mockWorkspace(opts: {
	awareness: YAwareness;
	respond: (call: RpcCall) => Promise<Result<unknown, RpcError>>;
	calls?: RpcCall[];
}): PeerWorkspace {
	const calls = opts.calls ?? [];
	return {
		awareness: { raw: opts.awareness },
		sync: {
			async rpc(target, action, input, options) {
				const call = { target, action, input, options };
				calls.push(call);
				return opts.respond(call);
			},
		},
	};
}

describe('resolvePeer', () => {
	it('returns Err(PeerNotFound) when awareness is empty', () => {
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);
		const result = resolvePeer(awareness, 'nonexistent');
		expect(isErr(result)).toBe(true);
		if (isErr(result)) {
			expect(isRpcError(result.error)).toBe(true);
			expect(result.error.name).toBe('PeerNotFound');
		}
	});

	it('returns the matching clientId', () => {
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);
		awareness.setLocalState({ device: { id: 'macbook-pro' } });
		const result = resolvePeer(awareness, 'macbook-pro');
		expect(result.error).toBeNull();
		expect(result.data).toBe(awareness.clientID);
	});

	it('first-match by clientId-ascending order on duplicates', () => {
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);
		// Inject two states sharing the same deviceId at different clientIds.
		awareness.getStates().set(50, { device: { id: 'shared' } });
		awareness.getStates().set(20, { device: { id: 'shared' } });
		awareness.getStates().set(80, { device: { id: 'shared' } });
		const result = resolvePeer(awareness, 'shared');
		expect(result.data).toBe(20);
	});

	it('skips states with mismatched deviceId', () => {
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);
		awareness.getStates().set(10, { device: { id: 'other' } });
		awareness.getStates().set(20, { device: { id: 'target' } });
		const result = resolvePeer(awareness, 'target');
		expect(result.data).toBe(20);
	});
});

describe('peer<T>()', () => {
	it('builds a proxy whose dot-path becomes the rpc action arg', async () => {
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);
		awareness.getStates().set(42, { device: { id: 'mac' } });

		const calls: RpcCall[] = [];
		const ws = mockWorkspace({
			awareness,
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
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);

		const calls: RpcCall[] = [];
		const ws = mockWorkspace({
			awareness,
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
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);
		awareness.getStates().set(1, { device: { id: 'mac' } });

		const ws = mockWorkspace({
			awareness,
			respond: async () => Err(RpcError.ActionNotFound({ action: 'x' }).error),
		});

		const remote = peer<TestActions>(ws, 'mac');
		const result = await remote.x();
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('ActionNotFound');
		}
	});

	it('rejects with PeerLeft when awareness change drops the peer mid-call', async () => {
		const ydoc = new Y.Doc();
		const awareness = new YAwareness(ydoc);
		awareness.getStates().set(7, { device: { id: 'mac' } });

		// Hold the rpc response forever so the disconnect can race ahead.
		const ws = mockWorkspace({
			awareness,
			respond: () => new Promise<Result<unknown, RpcError>>(() => {}),
		});

		const remote = peer<TestActions>(ws, 'mac');
		const callPromise = remote.tabs.close({ tabIds: [1] });

		// Drop the peer from awareness and emit a change event.
		awareness.getStates().delete(7);
		awareness.emit('change', [
			{ added: [], updated: [], removed: [7] },
			'local',
		]);

		const result = await callPromise;
		expect(isErr(result)).toBe(true);
		if (isErr(result) && isRpcError(result.error)) {
			expect(result.error.name).toBe('PeerLeft');
		}
	});
});
