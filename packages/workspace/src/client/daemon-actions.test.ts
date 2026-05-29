/**
 * Smoke tests for `buildDaemonActions`. Uses a stub `DaemonClient` that
 * records every call rather than touching a real socket: the runtime
 * Proxy machinery is what we're verifying, not transport.
 */

import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { InvokeRequest } from '../daemon/app.js';
import type { DaemonClient } from '../daemon/client.js';
import { buildDaemonActions } from './daemon-actions.js';

function makeStubClient() {
	const calls: { method: 'invoke'; arg: unknown }[] = [];
	const unreachable = () => {
		throw new Error('stub: not used by these tests');
	};
	const client = {
		peers: unreachable as DaemonClient['peers'],
		list: unreachable as DaemonClient['list'],
		dispatch: unreachable as DaemonClient['dispatch'],
		invoke: (input: InvokeRequest) => {
			calls.push({ method: 'invoke', arg: input });
			return Promise.resolve(Ok(null)) as ReturnType<DaemonClient['invoke']>;
		},
	} satisfies DaemonClient;
	return { client, calls };
}

const WORKSPACE = 'demo';

describe('buildDaemonActions workspace facade', () => {
	test('action invokes literal workspace path over /invoke', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test: shape is irrelevant
		const workspace: any = buildDaemonActions(client, WORKSPACE);

		await workspace.entries_get('xyz');

		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('invoke');
		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.entries_get',
			input: 'xyz',
		});
	});
});
