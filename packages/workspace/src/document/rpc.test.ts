/**
 * RPC over Yjs State Tests
 *
 * Exercises `dispatch` and `attachActionRunner` end-to-end through a single
 * shared `Y.Doc`. The caller and the target both observe the same
 * `YKeyValueLww<Call>` on the same array, so no transport (WebSocket, sync
 * provider) is needed: writes flip the row's `response`, the caller's
 * `waitFor` settles, the `finally` deletes the row.
 *
 * Key behaviors:
 * - Happy paths (no input, with input, raw-value Ok-wrap)
 * - Action returning `Err(...)` or throwing both surface as `ActionFailed`
 * - Unknown action surfaces as `ActionNotFound`
 * - External cancel and timeout both surface as `Cancelled` with the
 *   appropriate `reason`
 * - Row is deleted from the store after settle
 * - Routing by `connId` only dispatches to the matching runner
 */

import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import * as Y from 'yjs';
import {
	type ActionRegistry,
	defineMutation,
	defineQuery,
} from '../shared/actions.js';
import { RPC_KEY } from './keys.js';
import { attachActionRunner, type Call, dispatch } from './rpc.js';
import { YKeyValueLww } from './y-keyvalue/y-keyvalue-lww.js';

function setup(actions: ActionRegistry, targetConnId = 'target') {
	const ydoc = new Y.Doc();
	const rpc = new YKeyValueLww<Call>(ydoc.getArray(RPC_KEY));
	const detach = attachActionRunner(rpc, targetConnId, actions);
	return { ydoc, rpc, targetConnId, detach };
}

describe('rpc', () => {
	test('happy path (no input): query returns Ok value', async () => {
		const { rpc, targetConnId, detach } = setup({
			noop_ping: defineQuery({ handler: () => Ok('pong') }),
		});

		const result = await dispatch<undefined, string>(
			rpc,
			'noop_ping',
			undefined,
			{ to: targetConnId, signal: AbortSignal.timeout(1000) },
		);

		expect(result.error).toBeNull();
		expect(result.data).toBe('pong');
		detach();
	});

	test('happy path (with input): echoes the payload', async () => {
		const { rpc, targetConnId, detach } = setup({
			echo: defineQuery({
				input: Type.Object({ msg: Type.String() }),
				handler: ({ msg }) => Ok({ echoed: msg }),
			}),
		});

		const result = await dispatch<{ msg: string }, { echoed: string }>(
			rpc,
			'echo',
			{ msg: 'hi' },
			{ to: targetConnId, signal: AbortSignal.timeout(1000) },
		);

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ echoed: 'hi' });
		detach();
	});

	test('raw return value: Ok-wrapped by the runner', async () => {
		const { rpc, targetConnId, detach } = setup({
			answer: defineQuery({ handler: () => 42 }),
		});

		const result = await dispatch<undefined, number>(rpc, 'answer', undefined, {
			to: targetConnId,
			signal: AbortSignal.timeout(1000),
		});

		expect(result.error).toBeNull();
		expect(result.data).toBe(42);
		detach();
	});

	test('Err return: wrapped into ActionFailed with cause preserved', async () => {
		const { rpc, targetConnId, detach } = setup({
			fail_err: defineMutation({
				handler: () => Err(new Error('domain error')),
			}),
		});

		const result = await dispatch(rpc, 'fail_err', undefined, {
			to: targetConnId,
			signal: AbortSignal.timeout(1000),
		});

		expect(result.error).not.toBeNull();
		expect(result.error?.name).toBe('ActionFailed');
		if (result.error?.name !== 'ActionFailed') throw new Error('unreachable');
		expect(result.error.action).toBe('fail_err');
		expect(result.error.cause).toBeInstanceOf(Error);
		expect((result.error.cause as Error).message).toBe('domain error');
		detach();
	});

	test('thrown error: wrapped into ActionFailed with cause preserved', async () => {
		const { rpc, targetConnId, detach } = setup({
			fail_throw: defineMutation({
				handler: () => {
					throw new Error('boom');
				},
			}),
		});

		const result = await dispatch(rpc, 'fail_throw', undefined, {
			to: targetConnId,
			signal: AbortSignal.timeout(1000),
		});

		expect(result.error?.name).toBe('ActionFailed');
		if (result.error?.name !== 'ActionFailed') throw new Error('unreachable');
		expect(result.error.action).toBe('fail_throw');
		expect(result.error.cause).toBeInstanceOf(Error);
		expect((result.error.cause as Error).message).toBe('boom');
		detach();
	});

	test('unknown action: ActionNotFound with the missing key', async () => {
		const { rpc, targetConnId, detach } = setup({
			// Registered something, just not the one we ask for.
			something_else: defineQuery({ handler: () => Ok(null) }),
		});

		const result = await dispatch(rpc, 'no_such_action', undefined, {
			to: targetConnId,
			signal: AbortSignal.timeout(1000),
		});

		expect(result.error?.name).toBe('ActionNotFound');
		if (result.error?.name !== 'ActionNotFound') throw new Error('unreachable');
		expect(result.error.action).toBe('no_such_action');
		detach();
	});

	test('AbortController cancel: Cancelled with the controller reason', async () => {
		// No runner on `no-handler-here`, so dispatch will hang until aborted.
		const { rpc, detach } = setup({});
		const controller = new AbortController();

		const pending = dispatch(rpc, 'whatever', undefined, {
			to: 'no-handler-here',
			signal: controller.signal,
		});

		// Yield a microtask so the dispatch's observer + abort listener are wired.
		await Promise.resolve();
		controller.abort('user-cancel');

		const result = await pending;
		expect(result.error?.name).toBe('Cancelled');
		if (result.error?.name !== 'Cancelled') throw new Error('unreachable');
		expect(result.error.reason).toBe('user-cancel');
		detach();
	});

	test('AbortSignal.timeout: Cancelled with a TimeoutError DOMException', async () => {
		// No runner observing this `to`, so the only way out is the timeout.
		const { rpc, detach } = setup({});

		const result = await dispatch(rpc, 'whatever', undefined, {
			to: 'no-handler-here',
			signal: AbortSignal.timeout(20),
		});

		expect(result.error?.name).toBe('Cancelled');
		if (result.error?.name !== 'Cancelled') throw new Error('unreachable');
		expect(result.error.reason).toBeInstanceOf(DOMException);
		expect((result.error.reason as DOMException).name).toBe('TimeoutError');
		detach();
	});

	test('row is deleted after settle (finally branch ran)', async () => {
		const { rpc, targetConnId, detach } = setup({
			noop_ping: defineQuery({ handler: () => Ok('pong') }),
		});

		const result = await dispatch(rpc, 'noop_ping', undefined, {
			to: targetConnId,
			signal: AbortSignal.timeout(1000),
		});

		expect(result.error).toBeNull();
		expect(rpc.size).toBe(0);
		detach();
	});

	test('routing: only the matching connId observer runs', async () => {
		const ydoc = new Y.Doc();
		const rpc = new YKeyValueLww<Call>(ydoc.getArray(RPC_KEY));

		let countA = 0;
		let countB = 0;

		const detachA = attachActionRunner(rpc, 'connA', {
			tally: defineQuery({
				handler: () => {
					countA += 1;
					return Ok('A');
				},
			}),
		});
		const detachB = attachActionRunner(rpc, 'connB', {
			tally: defineQuery({
				handler: () => {
					countB += 1;
					return Ok('B');
				},
			}),
		});

		const result = await dispatch<undefined, string>(rpc, 'tally', undefined, {
			to: 'connA',
			signal: AbortSignal.timeout(1000),
		});

		expect(result.error).toBeNull();
		expect(result.data).toBe('A');
		expect(countA).toBe(1);
		expect(countB).toBe(0);

		detachA();
		detachB();
	});
});
