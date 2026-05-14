/**
 * Coverage for the `/list` route. Exercises the route via `app.request`
 * against an in-memory Hono app, no unix socket spun up. The wire shape
 * round-trips through serialization the same way the daemonClient sees
 * it, so this is the load-bearing test surface for list dispatch logic.
 *
 * `/list` is now a one-primitive route: describe every hosted route and
 * prefix each action key with the route name.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import * as Y from 'yjs';

import type { Collaboration } from '../document/open-collaboration.js';
import {
	type ActionManifest,
	type ActionRegistry,
	defineQuery,
} from '../shared/actions.js';
import { buildDaemonApp } from './app.js';
import type { StartedDaemonRoute } from './types.js';

type ListResult = Result<ActionManifest, never>;

function fakeEntry(
	name: string,
	actions: ActionRegistry = {},
): StartedDaemonRoute {
	const ydoc = new Y.Doc();
	const collaboration = {
		replica: { id: 'self', platform: 'node' },
		actions,
		status: { phase: 'connected' },
		whenConnected: Promise.resolve(),
		whenDisposed: Promise.resolve(),
		onStatusChange: () => () => {},
		reconnect() {},
		peers: {
			list: () => [],
			find: () => undefined,
			observe: () => () => {},
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	} as Collaboration<typeof actions>;

	return {
		route: name,
		runtime: {
			collaboration,
			async [Symbol.asyncDispose]() {
				ydoc.destroy();
			},
		},
	};
}

async function postList(runtimes: StartedDaemonRoute[]): Promise<ListResult> {
	const app = buildDaemonApp(runtimes);
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
				counter_get: defineQuery({
					description: 'Read the counter',
					handler: () => 0,
				}),
			}),
		]);
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(Object.keys(reply.data).sort()).toEqual(['demo.counter_get']);
			expect(reply.data['demo.counter_get']?.description).toBe(
				'Read the counter',
			);
		}
	});

	test('returns an empty manifest when the collaboration has no actions', async () => {
		const reply = await postList([fakeEntry('demo')]);
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(reply.data).toEqual({});
		}
	});

	test('prefixes actions from every daemon route', async () => {
		const reply = await postList([
			fakeEntry('notes', {
				notes_add: defineQuery({ handler: () => null }),
			}),
			fakeEntry('tasks', {
				tasks_list: defineQuery({ handler: () => [] }),
			}),
		]);

		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(Object.keys(reply.data).sort()).toEqual([
				'notes.notes_add',
				'tasks.tasks_list',
			]);
		}
	});
});
