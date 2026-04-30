/**
 * Coverage for the `/list` route. Exercises the route via `app.request`
 * against an in-memory Hono app, no unix socket spun up. The wire shape
 * round-trips through serialization the same way the daemonClient sees
 * it, so this is the load-bearing test surface for list dispatch logic.
 *
 * `/list` is now a one-primitive route: describe every hosted export and
 * prefix each action path with the config export name.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';

import { type ActionManifest, defineQuery } from '../shared/actions.js';
import { buildApp } from './app.js';
import type { LoadedWorkspace, WorkspaceEntry } from './types.js';

type ListResult = Result<ActionManifest, never>;

function fakeEntry(
	name: string,
	actions?: Record<string, unknown>,
): WorkspaceEntry {
	const workspace = {
		whenReady: Promise.resolve(),
		...(actions ?? {}),
		[Symbol.dispose]() {},
	} satisfies LoadedWorkspace;
	return { name, workspace } as WorkspaceEntry;
}

async function postList(entries: WorkspaceEntry[]): Promise<ListResult> {
	const app = buildApp(entries);
	const res = await app.request('/list', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	return res.json();
}

describe('/list route', () => {
	test('returns export-prefixed describeActions output', async () => {
		const reply = await postList([
			fakeEntry('demo', {
				counter: {
					get: defineQuery({
						description: 'Read the counter',
						handler: () => 0,
					}),
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

	test('returns an empty manifest when the workspace has no actions', async () => {
		const reply = await postList([fakeEntry('demo')]);
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(reply.data).toEqual({});
		}
	});

	test('prefixes actions from every config export', async () => {
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
				'notes.actions.add',
				'tasks.actions.list',
			]);
		}
	});
});
