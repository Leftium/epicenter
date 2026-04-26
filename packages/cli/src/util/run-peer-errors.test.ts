/**
 * Error-emission tests for the `run --peer` path.
 *
 * Covers the simplified miss shapes (no peers seen, peers seen but no match)
 * and every `RpcError` variant. Capture `console.error` and assert
 * line-by-line. RPC errors are constructed via `RpcError.X({...}).error` so
 * they match the wire shape exactly.
 */
import { RpcError } from '@epicenter/workspace';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { AwarenessState } from '../load-config';
import { emitMissError, emitRpcError } from './run-peer-errors';

function mockState(device: Partial<AwarenessState['device']> = {}): AwarenessState {
	return {
		device: {
			id: 'mac-1',
			name: 'MacBook',
			platform: 'tauri',
			offers: {},
			...device,
		},
	};
}

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

	test('peers present but no match → points at `epicenter peers`', () => {
		cap = captureErrors();
		emitMissError('ghost', true, undefined, 5000);
		expect(cap.lines).toEqual([
			'error: no peer matches deviceId "ghost"',
			'run `epicenter peers` to see connected peers',
		]);
	});

	test('peers present + -w → scoped hint', () => {
		cap = captureErrors();
		emitMissError('ghost', true, 'tabManager', 5000);
		expect(cap.lines).toEqual([
			'error: no peer matches deviceId "ghost" in workspace tabManager',
			'run `epicenter peers -w tabManager` to see connected peers',
		]);
	});

	test('no peers seen during wait → "no peers seen after waiting"', () => {
		cap = captureErrors();
		emitMissError('macbook-pro', false, undefined, 5000);
		expect(cap.lines).toEqual([
			'error: no peers seen after waiting 5000ms for "macbook-pro"',
		]);
	});
});

describe('emitRpcError', () => {
	let cap: ReturnType<typeof captureErrors>;
	afterEach(() => cap?.restore());

	test('ActionNotFound labels with device.name + platform', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.ActionNotFound({ action: 'tabs.closeAll' }).error,
			42,
			mockState({ name: 'MacBook', platform: 'tauri' }),
		);
		expect(cap.lines).toEqual([
			'error: ActionNotFound "tabs.closeAll" on MacBook (42, tauri)',
		]);
	});

	test('Timeout reports ms and peer', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.Timeout({ ms: 5000 }).error,
			42,
			mockState({ name: 'MacBook', platform: 'tauri' }),
		);
		expect(cap.lines).toEqual([
			'error: timeout after 5000ms on MacBook (42, tauri)',
		]);
	});

	test('PeerOffline', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.PeerOffline().error,
			42,
			mockState({ name: 'MacBook', platform: 'tauri' }),
		);
		expect(cap.lines).toEqual([
			'error: peer MacBook (42, tauri) is offline',
		]);
	});

	test('PeerNotFound surfaces the deviceId', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.PeerNotFound({ peer: 'macbook-pro' }).error,
			0,
			mockState(),
		);
		expect(cap.lines).toEqual([
			'error: no peer with deviceId "macbook-pro"',
		]);
	});

	test('PeerLeft surfaces the deviceId', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.PeerLeft({ peer: 'macbook-pro' }).error,
			0,
			mockState(),
		);
		expect(cap.lines).toEqual([
			'error: peer "macbook-pro" disconnected before responding',
		]);
	});

	test('ActionFailed surfaces underlying cause', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.ActionFailed({
				action: 'tabs.close',
				cause: new Error('Tab 99 not found'),
			}).error,
			42,
			mockState({ name: 'MacBook', platform: 'tauri' }),
		);
		expect(cap.lines).toEqual([
			'error: "tabs.close" failed on MacBook (42, tauri): Tab 99 not found',
		]);
	});

	test('Disconnected', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.Disconnected().error,
			42,
			mockState({ name: 'MacBook', platform: 'tauri' }),
		);
		expect(cap.lines).toEqual([
			'error: connection lost before MacBook (42, tauri) responded',
		]);
	});
});
