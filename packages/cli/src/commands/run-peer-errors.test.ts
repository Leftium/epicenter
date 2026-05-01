/**
 * Error-emission tests for the `run --peer` path.
 *
 * Covers the simplified miss shapes (no peers seen, peers seen but no match)
 * and every `RpcError` variant. Capture `console.error` and assert
 * line-by-line. RPC errors are constructed via `RpcError.X({...}).error` so
 * they match the wire shape exactly.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { RpcError } from '@epicenter/workspace';
import type { AwarenessState } from '../load-config';
import { emitMissError, emitPeerLeftError, emitRpcError } from './run';

function mockState(peer: Partial<AwarenessState['peer']> = {}): AwarenessState {
	return {
		peer: {
			id: 'mac-1',
			name: 'MacBook',
			platform: 'tauri',
			...peer,
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

	test('peers present but no match points at `epicenter peers`', () => {
		cap = captureErrors();
		emitMissError('ghost', true, 5000);
		expect(cap.lines).toEqual([
			'error: no peer matches peer id "ghost"',
			'run `epicenter peers` to see connected peers',
		]);
	});

	test('no peers seen during wait reports wait duration', () => {
		cap = captureErrors();
		emitMissError('macbook-pro', false, 5000);
		expect(cap.lines).toEqual([
			'error: no peers seen after waiting 5000ms for "macbook-pro"',
		]);
	});
});

describe('emitRpcError', () => {
	let cap: ReturnType<typeof captureErrors>;
	afterEach(() => cap?.restore());

	test('ActionNotFound labels with peer id', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.ActionNotFound({ action: 'tabs.closeAll' }).error,
			'macbook-pro',
		);
		expect(cap.lines).toEqual([
			'error: ActionNotFound "tabs.closeAll" on macbook-pro',
		]);
	});

	test('Timeout reports ms and peer', () => {
		cap = captureErrors();
		emitRpcError(RpcError.Timeout({ ms: 5000 }).error, 'macbook-pro');
		expect(cap.lines).toEqual(['error: timeout after 5000ms on macbook-pro']);
	});

	test('PeerOffline', () => {
		cap = captureErrors();
		emitRpcError(RpcError.PeerOffline().error, 'macbook-pro');
		expect(cap.lines).toEqual(['error: peer macbook-pro is offline']);
	});

	test('PeerLeft surfaces the peer id', () => {
		cap = captureErrors();
		emitPeerLeftError(
			'macbook-pro',
			42,
			mockState({ name: 'MacBook', platform: 'tauri' }),
		);
		expect(cap.lines).toEqual([
			'error: peer "macbook-pro" disconnected before responding',
			'  last seen as MacBook (42, tauri)',
		]);
	});

	test('ActionFailed surfaces underlying cause', () => {
		cap = captureErrors();
		emitRpcError(
			RpcError.ActionFailed({
				action: 'tabs.close',
				cause: new Error('Tab 99 not found'),
			}).error,
			'macbook-pro',
		);
		expect(cap.lines).toEqual([
			'error: "tabs.close" failed on macbook-pro: Tab 99 not found',
		]);
	});

	test('Disconnected', () => {
		cap = captureErrors();
		emitRpcError(RpcError.Disconnected().error, 'macbook-pro');
		expect(cap.lines).toEqual([
			'error: connection lost before macbook-pro responded',
		]);
	});
});
