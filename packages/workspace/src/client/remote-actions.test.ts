/**
 * Smoke tests for `buildRemoteActions`. Uses a stub `DaemonClient` that
 * records every call rather than touching a real socket: the runtime
 * Proxy machinery is what we're verifying, not transport.
 */

import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { RunRequest } from '../daemon/app.js';
import type { DaemonClient } from '../daemon/client.js';
import { buildRemoteActions } from './remote-actions.js';

function makeStubClient() {
	const calls: { method: 'run' | 'peers' | 'list'; arg: unknown }[] = [];
	const client: DaemonClient = {
		peers: () => {
			calls.push({ method: 'peers', arg: undefined });
			return Promise.resolve(Ok([])) as ReturnType<DaemonClient['peers']>;
		},
		list: () => {
			calls.push({ method: 'list', arg: undefined });
			return Promise.resolve(Ok({})) as ReturnType<DaemonClient['list']>;
		},
		run: (input: RunRequest) => {
			calls.push({ method: 'run', arg: input });
			return Promise.resolve(Ok(null)) as ReturnType<DaemonClient['run']>;
		},
		shutdown: () =>
			Promise.resolve(Ok(null)) as ReturnType<DaemonClient['shutdown']>,
	};
	return { client, calls };
}

const WORKSPACE = 'demo';

describe('buildRemoteActions registry', () => {
	test('domain action dispatches registry-relative path over /run', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test: shape is irrelevant
		const actions: any = buildRemoteActions(client, WORKSPACE);

		await actions.entries.get('xyz');

		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('run');
		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.entries.get',
			input: 'xyz',
		});
	});

	test('mutation dispatches with the input as payload', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const actions: any = buildRemoteActions(client, WORKSPACE);
		const row = { id: 'a', title: 'hi', _v: 1 };

		await actions.entries.set(row);

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.entries.set',
			input: row,
		});
	});

	test('deeply nested action traverses and joins with .', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const actions: any = buildRemoteActions(client, WORKSPACE);

		await actions.deeply.nested.action({ x: 1 });

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.deeply.nested.action',
			input: { x: 1 },
		});
	});

	test('action with no input sends undefined', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const actions: any = buildRemoteActions(client, WORKSPACE);

		await actions.status();

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.status',
			input: undefined,
		});
	});

	test('intermediate namespace access does not dispatch', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const actions: any = buildRemoteActions(client, WORKSPACE);

		// Just walking the chain should issue zero RPCs.
		const namespace = actions.deeply.nested;
		expect(calls).toHaveLength(0);

		await namespace.action({});
		expect(calls).toHaveLength(1);
	});
});
