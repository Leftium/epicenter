/**
 * Error-emission tests for the `run --peer` path.
 *
 * Covers the error shapes from the spec's Terminal Sessions section:
 *   - miss: case-suggest / case-ambiguous / not-found (with and without peers,
 *     with and without -w)
 *   - rpc: ActionNotFound / Timeout / PeerOffline / ActionFailed / Disconnected
 *
 * Capture `console.error` and assert line-by-line. Covers formatting only —
 * the full resolver + polling flow is exercised by `find-peer.test.ts` and
 * by hand-running the command against a playground config.
 *
 * RPC error values are constructed via `RpcError.X({...}).error` so they
 * match the wire shape exactly — same path production takes after receiving
 * an error over the sync channel.
 */
import { RpcError } from '@epicenter/workspace';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { emitMissError, emitRpcError } from './emit-peer-errors';

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

describe('emitMissError', () => {
	let cap: ReturnType<typeof captureErrors>;
	afterEach(() => cap?.restore());

	test('case-suggest → "did you mean"', () => {
		cap = captureErrors();
		emitMissError(
			'mymacbook',
			{ kind: 'case-suggest', actual: 'myMacbook', clientID: 42 },
			true,
			undefined,
			5000,
		);
		expect(cap.lines).toEqual([
			'error: no peer matches "mymacbook"',
			'did you mean: myMacbook?',
		]);
	});

	test('case-ambiguous → lists padded name + clientID', () => {
		cap = captureErrors();
		emitMissError(
			'MACBOOK',
			{
				kind: 'case-ambiguous',
				matches: [
					{ value: 'myMacbook', clientID: 42 },
					{ value: 'workMacbook', clientID: 188 },
				],
			},
			true,
			undefined,
			5000,
		);
		expect(cap.lines).toEqual([
			'error: no peer matches "MACBOOK"',
			'multiple peers match case-insensitively:',
			'  myMacbook        (42)',
			'  workMacbook      (188)',
		]);
	});

	test('not-found with peers present → points at `epicenter peers`', () => {
		cap = captureErrors();
		emitMissError('ghost', { kind: 'not-found' }, true, undefined, 5000);
		expect(cap.lines).toEqual([
			'error: no peer matches "ghost"',
			'run `epicenter peers` to see connected peers',
		]);
	});

	test('not-found with peers present + -w → scoped hint', () => {
		cap = captureErrors();
		emitMissError(
			'ghost',
			{ kind: 'not-found' },
			true,
			'tabManager',
			5000,
		);
		expect(cap.lines).toEqual([
			'error: no peer matches "ghost" in workspace tabManager',
			'run `epicenter peers -w tabManager` to see connected peers',
		]);
	});

	test('not-found with no peers seen → no peers seen after wait', () => {
		cap = captureErrors();
		emitMissError(
			'myMacbook',
			{ kind: 'not-found' },
			false,
			undefined,
			5000,
		);
		expect(cap.lines).toEqual([
			'error: no peers seen after waiting 5000ms for "myMacbook"',
		]);
	});
});

describe('emitRpcError', () => {
	let cap: ReturnType<typeof captureErrors>;
	afterEach(() => cap?.restore());

	test('ActionNotFound with deviceName + version', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.ActionNotFound({ action: 'tabs.closeAll' }).error,
			42,
			{ deviceName: 'myMacbook', version: '1.4.2' },
		);
		expect(cap.lines).toEqual([
			'error: ActionNotFound "tabs.closeAll" on myMacbook (42, v1.4.2)',
		]);
	});

	test('ActionNotFound without deviceName falls back to clientID label', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.ActionNotFound({ action: 'tabs.closeAll' }).error,
			42,
			{},
		);
		expect(cap.lines).toEqual([
			'error: ActionNotFound "tabs.closeAll" on clientID 42',
		]);
	});

	test('Timeout reports ms and peer', () => {
		cap = captureErrors();
		emitRpcError(RpcError.Timeout({ ms: 5000 }).error, 42, {
			deviceName: 'myMacbook',
		});
		expect(cap.lines).toEqual([
			'error: timeout after 5000ms on myMacbook (42)',
		]);
	});

	test('PeerOffline', () => {
		cap = captureErrors();
		emitRpcError(RpcError.PeerOffline().error, 42, {
			deviceName: 'myMacbook',
		});
		expect(cap.lines).toEqual(['error: peer myMacbook (42) is offline']);
	});

	test('ActionFailed surfaces underlying cause', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.ActionFailed({
				action: 'tabs.close',
				cause: new Error('Tab 99 not found'),
			}).error,
			42,
			{ deviceName: 'myMacbook' },
		);
		expect(cap.lines).toEqual([
			'error: "tabs.close" failed on myMacbook (42): Tab 99 not found',
		]);
	});

	test('Disconnected', () => {
		cap = captureErrors();
		emitRpcError(RpcError.Disconnected().error, 42, {});
		expect(cap.lines).toEqual([
			'error: connection lost before clientID 42 responded',
		]);
	});
});
