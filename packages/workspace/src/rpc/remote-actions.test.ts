/**
 * `createRemoteActions` tests — verifies the client-side proxy that mirrors
 * a local action tree and routes calls through a caller-supplied transport.
 *
 * The proxy's job is narrow:
 * - Shape-mirror the input tree so `remote.tabs.close({...})` is a function.
 * - Call `send(path, input)` with a dot-path derived from tree walk.
 * - Normalize the transport's return: Result passthrough, raw → Ok, throw → ActionFailed.
 */

import { describe, expect, test } from 'bun:test';
import { RpcError } from '@epicenter/sync';
import Type from 'typebox';
import { Ok, isErr, isOk } from 'wellcrafted/result';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { createRemoteActions, type RemoteSend } from './remote-actions.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Capture every send call and let the test script the response. */
function recordingSend(respond: (path: string, input: unknown) => unknown) {
	const calls: { path: string; input: unknown }[] = [];
	const send: RemoteSend = async (path, input) => {
		calls.push({ path, input });
		return respond(path, input);
	};
	return { send, calls };
}

// The proxy walks runtime keys only — handler bodies never run. The schemas
// and return types matter for the `RemoteActions<A>` type surface, not for
// runtime behavior.
const exampleActions = {
	tabs: {
		close: defineMutation({
			input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
			handler: async (_: { tabIds: number[] }) => Ok({ closedCount: 0 }),
		}),
		list: defineQuery({
			handler: async () => [] as { id: number }[],
		}),
	},
	devices: {
		list: defineQuery({
			handler: () => ({ devices: [] as { id: string }[] }),
		}),
	},
};

// ── Tests ────────────────────────────────────────────────────────────────

describe('createRemoteActions', () => {
	test('mirrors the action tree shape — nested paths become callable leaves', () => {
		const { send } = recordingSend(() => Ok(null));
		const remote = createRemoteActions(exampleActions, send);

		expect(typeof remote.tabs.close).toBe('function');
		expect(typeof remote.tabs.list).toBe('function');
		expect(typeof remote.devices.list).toBe('function');
	});

	test('send is called with a dot-path derived from the tree walk', async () => {
		const { send, calls } = recordingSend(() => Ok(null));
		const remote = createRemoteActions(exampleActions, send);

		await remote.tabs.close({ tabIds: [1, 2] });
		await remote.devices.list();

		expect(calls).toEqual([
			{ path: 'tabs.close', input: { tabIds: [1, 2] } },
			{ path: 'devices.list', input: undefined },
		]);
	});

	test('Ok from transport passes through to the caller', async () => {
		const { send } = recordingSend(() => Ok({ closedCount: 3 }));
		const remote = createRemoteActions(exampleActions, send);

		const result = await remote.tabs.close({ tabIds: [1, 2, 3] });

		expect(isOk(result)).toBe(true);
		expect(result.data).toEqual({ closedCount: 3 });
		expect(result.error).toBeNull();
	});

	test('typed Err from transport passes through untouched — E is preserved', async () => {
		// The typed error reaches the caller with its original shape — the
		// proxy does not re-wrap it as ActionFailed. The runtime shape is
		// what matters; the static type on the test action isn't the point.
		const typedErr = {
			name: 'BrowserApiFailed' as const,
			operation: 'tabs.remove',
			message: 'tab does not exist',
		};
		// Construct the envelope directly rather than through `Err()` — the
		// wire format is the only thing the proxy observes, and typing `Err`
		// against an unrelated variant would force a test-only type gymnastic.
		const { send } = recordingSend(() => ({ data: null, error: typedErr }));
		const remote = createRemoteActions(exampleActions, send);

		const result = await remote.tabs.close({ tabIds: [999] });

		expect(isErr(result)).toBe(true);
		// Runtime shape assertion — the static action type declares `ActionFailed`
		// as the only Err variant, but the proxy is shape-agnostic at runtime and
		// forwards whatever the transport produced.
		expect(result.error as unknown).toEqual(typedErr);
	});

	test('raw value from transport gets Ok-wrapped defensively', async () => {
		// Well-behaved servers always send Results, but the factory tolerates
		// a raw value — important for hand-rolled transports and tests.
		const { send } = recordingSend(() => [{ id: 1 }, { id: 2 }]);
		const remote = createRemoteActions(exampleActions, send);

		const result = await remote.tabs.list();

		expect(isOk(result)).toBe(true);
		expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
	});

	test('transport throw becomes Err(RpcError.ActionFailed) with the dot-path + cause', async () => {
		const boom = new Error('network unreachable');
		const { send } = recordingSend(() => {
			throw boom;
		});
		const remote = createRemoteActions(exampleActions, send);

		const result = await remote.tabs.close({ tabIds: [1] });

		expect(isErr(result)).toBe(true);
		const err = result.error as RpcError;
		expect(err.name).toBe('ActionFailed');
		if (err.name !== 'ActionFailed') throw new Error('unreachable');
		expect(err.action).toBe('tabs.close');
		expect(err.cause).toBe(boom);
	});
});
