/**
 * Error-emission tests for the `run --peer` path.
 *
 * Covers the remote-call failure shapes (peer left, self invocation, and
 * every `RpcError` variant). Capture `console.error` and assert line-by-line.
 * RPC errors are constructed via `RpcError.X({...}).error` so they match the
 * wire shape exactly.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
	PeerLeftError,
	RpcError,
	SelfInvocationError,
} from '@epicenter/workspace';
import { emitRemoteCallError } from './run';

function captureErrors() {
	const lines: string[] = [];
	const spy = spyOn(console, 'error').mockImplementation(
		(...args: unknown[]) => {
			lines.push(args.map((a) => String(a)).join(' '));
		},
	);
	return {
		lines,
		restore: () => spy.mockRestore(),
	};
}

describe('emitRemoteCallError', () => {
	let cap: ReturnType<typeof captureErrors>;
	afterEach(() => cap?.restore());

	test('ActionNotFound labels with peer id', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			RpcError.ActionNotFound({ action: 'tabs.closeAll' }).error,
		);
		expect(cap.lines).toEqual([
			'error: ActionNotFound "tabs.closeAll" on macbook-pro',
		]);
	});

	test('Timeout reports ms and peer', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			RpcError.Timeout({ ms: 5000 }).error,
		);
		expect(cap.lines).toEqual(['error: timeout after 5000ms on macbook-pro']);
	});

	test('PeerOffline', () => {
		cap = captureErrors();
		emitRemoteCallError('macbook-pro', RpcError.PeerOffline().error);
		expect(cap.lines).toEqual(['error: peer macbook-pro is offline']);
	});

	test('PeerLeft surfaces the peer id and action', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			PeerLeftError.PeerLeft({
				peerId: 'macbook-pro',
				action: 'tabs.close',
			}).error,
		);
		expect(cap.lines).toEqual([
			'error: peer "macbook-pro" disconnected before "tabs.close" responded',
		]);
	});

	test('SelfInvocation reports the action', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'self',
			SelfInvocationError.SelfInvocation({ action: 'tabs.list' }).error,
		);
		expect(cap.lines).toEqual([
			'error: cannot RPC to self for "tabs.list"',
		]);
	});

	test('ActionFailed surfaces underlying cause', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			RpcError.ActionFailed({
				action: 'tabs.close',
				cause: new Error('Tab 99 not found'),
			}).error,
		);
		expect(cap.lines).toEqual([
			'error: "tabs.close" failed on macbook-pro: Tab 99 not found',
		]);
	});

	test('Disconnected', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			RpcError.Disconnected().error,
		);
		expect(cap.lines).toEqual([
			'error: connection lost before macbook-pro responded',
		]);
	});
});
