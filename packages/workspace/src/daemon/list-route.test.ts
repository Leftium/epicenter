/**
 * Coverage for the `/list` route. Exercises the route via `app.request`
 * against an in-memory Hono app, no unix socket spun up. The wire shape
 * round-trips through serialization the same way the daemonClient sees
 * it, so this is the load-bearing test surface for list dispatch logic.
 *
 * `/list` is now a one-primitive route: describe every hosted route and
 * prefix each action path with the route name.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';

import { type ActionManifest, defineQuery } from '../shared/actions.js';
import { buildDaemonApp } from './app.js';
import type { DaemonRuntime, DaemonRuntimeEntry } from './types.js';

type ListResult = Result<ActionManifest, never>;

function fakeEntry(
	name: string,
	workspaceShape: Record<string, unknown> = {},
): DaemonRuntimeEntry {
	const workspace = {
		workspaceId: `epicenter.${name}`,
		actions: {},
		sync: {
			whenConnected: Promise.resolve(),
			status: { phase: 'connected', hasLocalChanges: false },
			onStatusChange: () => () => {},
			goOffline() {},
			reconnect() {},
			whenDisposed: Promise.resolve(),
		} as unknown as DaemonRuntime['sync'],
		presence: {
			peers: () => new Map(),
			find: () => undefined,
			waitForPeer: async () => ({
				data: null,
				error: {
					name: 'PeerMiss',
					message: 'missing peer',
					peerTarget: 'missing',
					sawPeers: false,
					waitMs: 1,
					emptyReason: null,
				},
			}),
			observe: () => () => {},
		} as unknown as DaemonRuntime['presence'],
		rpc: {
			rpc: async () => ({ data: null, error: null }),
		} as unknown as DaemonRuntime['rpc'],
		...workspaceShape,
		[Symbol.dispose]() {},
	} satisfies DaemonRuntime;
	return {
		route: name,
		workspace,
	};
}

async function postList(entries: DaemonRuntimeEntry[]): Promise<ListResult> {
	const app = buildDaemonApp(entries);
	const res = await app.request('/list', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	return res.json();
}

describe('/list route', () => {
	test('returns route-prefixed paths under the action root', async () => {
		const reply = await postList([
			fakeEntry('demo', {
				actions: {
					counter: {
						get: defineQuery({
							description: 'Read the counter',
							handler: () => 0,
						}),
					},
				},
			}),
		]);
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(Object.keys(reply.data).sort()).toEqual(['demo.counter.get']);
			expect(reply.data['demo.counter.get']?.description).toBe(
				'Read the counter',
			);
		}
	});

	test('ignores action leaves outside the canonical action root', async () => {
		const reply = await postList([
			fakeEntry('demo', {
				actions: {},
				sqlite: {
					get: defineQuery({
						handler: () => 0,
					}),
				},
			}),
		]);

		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(reply.data).toEqual({});
		}
	});

	test('returns an empty manifest when the workspace has no actions', async () => {
		const reply = await postList([fakeEntry('demo')]);
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(reply.data).toEqual({});
		}
	});

	test('prefixes actions from every daemon route', async () => {
		const reply = await postList([
			fakeEntry('notes', {
				actions: {
					add: defineQuery({ handler: () => null }),
				},
			}),
			fakeEntry('tasks', {
				actions: {
					list: defineQuery({ handler: () => [] }),
				},
			}),
		]);

		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(Object.keys(reply.data).sort()).toEqual([
				'notes.add',
				'tasks.list',
			]);
		}
	});
});
