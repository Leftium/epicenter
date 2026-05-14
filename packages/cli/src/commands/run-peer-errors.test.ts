/**
 * Error-emission tests for the `run --peer` path.
 *
 * Covers every `DispatchError` variant. Capture `console.error` and assert
 * line-by-line. Dispatch errors are constructed via
 * `DispatchError.X({...}).error` so they match the wire shape exactly.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { DispatchError } from '@epicenter/workspace';
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

	test('Cancelled with TimeoutError reason prints timeout label', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.Cancelled({
				reason: new DOMException('Timed out', 'TimeoutError'),
			}).error,
		);
		expect(cap.lines).toEqual(['error: timeout calling macbook-pro']);
	});

	test('Cancelled with non-timeout reason prints generic cancel label', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.Cancelled({ reason: 'user-cancel' }).error,
		);
		expect(cap.lines).toEqual([
			'error: dispatch to macbook-pro was cancelled: user-cancel',
		]);
	});

	test('ActionNotFound labels with peer id', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.ActionNotFound({ action: 'tabs_close_all' }).error,
		);
		expect(cap.lines).toEqual([
			'error: ActionNotFound "tabs_close_all" on macbook-pro',
		]);
	});

	test('ActionFailed surfaces underlying cause', () => {
		cap = captureErrors();
		emitRemoteCallError(
			'macbook-pro',
			DispatchError.ActionFailed({
				action: 'tabs_close',
				cause: new Error('handler boom'),
			}).error,
		);
		expect(cap.lines).toEqual([
			'error: "tabs_close" failed on macbook-pro: handler boom',
		]);
	});
});
