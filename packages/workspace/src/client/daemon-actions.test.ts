/**
 * Smoke tests for `buildDaemonActions`. Uses a stub `DaemonClient` that
 * records every call rather than touching a real socket: the runtime
 * Proxy machinery is what we're verifying, not transport.
 */

import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { RunRequest } from '../daemon/app.js';
import type { DaemonClient } from '../daemon/client.js';
import { type ActionRegistry, defineQuery } from '../shared/actions.js';
import { buildDaemonActions, type DaemonActions } from './daemon-actions.js';

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

const typedActions = {
	visible: defineQuery({
		handler: () => 'visible',
	}),
	entries_get: defineQuery({
		handler: () => 'entry',
	}),
} satisfies ActionRegistry;

type TypedDaemonActions = DaemonActions<typeof typedActions>;

type Expect<TValue extends true> = TValue;
type Equal<TActual, TExpected> =
	IsAssignable<TActual, TExpected> extends true
		? IsAssignable<TExpected, TActual>
		: false;
type IsAssignable<TActual, TExpected> = [TActual] extends [TExpected]
	? true
	: false;
type HasKey<TObject, TKey extends PropertyKey> = TKey extends keyof TObject
	? true
	: false;

export type DaemonActionKeyPreserved = Expect<
	Equal<HasKey<TypedDaemonActions, 'entries_get'>, true>
>;
export type DaemonValidKeyPreserved = Expect<
	Equal<HasKey<TypedDaemonActions, 'visible'>, true>
>;

describe('buildDaemonActions workspace facade', () => {
	test('action dispatches literal workspace path over /run', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test: shape is irrelevant
		const workspace: any = buildDaemonActions(client, WORKSPACE);

		await workspace.entries_get('xyz');

		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('run');
		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.entries_get',
			input: 'xyz',
		});
	});

	test('mutation dispatches with the input as payload', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const workspace: any = buildDaemonActions(client, WORKSPACE);
		const row = { id: 'a', title: 'hi', _v: 1 };

		await workspace.entries_set(row);

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.entries_set',
			input: row,
		});
	});

	test('action with no input sends undefined', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const workspace: any = buildDaemonActions(client, WORKSPACE);

		await workspace.status();

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.status',
			input: undefined,
		});
	});

	test('action options override the daemon wait budget', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const workspace: any = buildDaemonActions(client, WORKSPACE);

		await workspace.status(undefined, { waitMs: 100 });

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'demo.status',
			input: undefined,
			waitMs: 100,
		});
	});
});
