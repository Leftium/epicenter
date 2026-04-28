/**
 * Coverage for the `/list` route. Exercises the route via `app.request`
 * against an in-memory Hono app, no unix socket spun up. The wire shape
 * round-trips through serialization the same way the daemonClient sees
 * it, so this is the load-bearing test surface for list dispatch logic.
 *
 * Cases:
 *   1. local mode: returns a sections array labeled by entry name.
 *   2. peer mode against a workspace with no sync: returns PeerMiss
 *      (the renderer translates exitCode=3).
 */

import { describe, expect, test } from 'bun:test';

import type { ListResult } from '../commands/list';
import type { LoadedWorkspace, WorkspaceEntry } from '../load-config';
import { buildApp } from './app';

function fakeEntry(
	name: string,
	actions?: Record<string, unknown>,
): WorkspaceEntry {
	const workspace: LoadedWorkspace = {
		whenReady: Promise.resolve(),
		actions: actions as LoadedWorkspace['actions'],
		[Symbol.dispose]() {},
	};
	return { name, workspace } as WorkspaceEntry;
}

async function postList(
	entry: WorkspaceEntry,
	body: unknown,
): Promise<ListResult> {
	const app = buildApp([entry], () => {});
	const res = await app.request('/list', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return res.json();
}

describe('/list route', () => {
	test('local mode returns a single section labeled by entry name', async () => {
		const reply = await postList(fakeEntry('demo'), {
			path: '',
			mode: { kind: 'local' },
			waitMs: 0,
		});
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(reply.data.sections).toHaveLength(1);
			expect(reply.data.sections[0]!.label).toBe('demo');
			expect(reply.data.sections[0]!.peer).toBe('self');
		}
	});

	test('peer mode against a workspace without sync returns PeerMiss', async () => {
		const reply = await postList(fakeEntry('demo'), {
			path: '',
			mode: { kind: 'peer', deviceId: 'nonexistent' },
			waitMs: 0,
		});
		expect(reply.error?.name).toBe('PeerMiss');
	});

	test('all mode against a workspace without sync still emits a self section', async () => {
		const reply = await postList(fakeEntry('demo'), {
			path: '',
			mode: { kind: 'all' },
			waitMs: 0,
		});
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(reply.data.sections).toHaveLength(1);
			expect(reply.data.sections[0]!.peer).toBe('self');
		}
	});
});
