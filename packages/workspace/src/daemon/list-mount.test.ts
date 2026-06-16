/**
 * Coverage for the `/list` manifest projection.
 *
 * `/list` describes the daemon's one mount and prefixes each action key with the
 * mount name. The shared action path helpers are covered here because `/list`
 * and action execution both rely on the same mount qualifier rules.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { PresenceDevice } from '../document/presence-protocol.js';
import {
	type ActionManifest,
	type ActionRegistry,
	defineQuery,
} from '../shared/actions.js';
import { joinDaemonActionPath, parseDaemonActionPath } from './action-path.js';
import { buildDaemonApp } from './app.js';
import type { DaemonServedMount } from './types.js';

function makeMount({
	mount,
	actions,
	collaboration = true,
	devices = [],
}: {
	mount: string;
	actions: ActionRegistry;
	collaboration?: boolean;
	devices?: PresenceDevice[];
}): DaemonServedMount {
	const runtime: DaemonServedMount['runtime'] = { actions };
	if (collaboration) {
		runtime.collaboration = {
			devices: {
				list: () => devices,
			},
			status: { phase: 'connected' },
			dispatch: async () => ({ data: null, error: null }) as never,
		};
	}
	return {
		mount,
		runtime,
	};
}

describe('daemon action path helpers', () => {
	test('joinDaemonActionPath prefixes local action paths with the mount', () => {
		expect(joinDaemonActionPath('demo', 'counter_get')).toBe(
			'demo.counter_get',
		);
	});

	test('parseDaemonActionPath separates the mount from the local action path', () => {
		expect(parseDaemonActionPath('demo.counter_get')).toEqual({
			mount: 'demo',
			localPath: 'counter_get',
		});
	});

	test('parseDaemonActionPath preserves invalid dotted action suffixes', () => {
		expect(parseDaemonActionPath('demo.counter.get')).toEqual({
			mount: 'demo',
			localPath: 'counter.get',
		});
	});
});

describe('/list route', () => {
	test('returns mount-prefixed paths under the action root', async () => {
		const res = await buildDaemonApp(
			makeMount({
				mount: 'demo',
				actions: {
					counter_get: defineQuery({
						description: 'Read the counter',
						handler: () => 0,
					}),
				},
			}),
		).request('/list', { method: 'POST' });

		const manifest = expectOk(
			(await res.json()) as Result<ActionManifest, never>,
		);
		expect(Object.keys(manifest).sort()).toEqual(['demo.counter_get']);
		expect(manifest['demo.counter_get']?.description).toBe('Read the counter');
	});

	test('returns an empty manifest when the mount has no actions', async () => {
		const res = await buildDaemonApp(
			makeMount({ mount: 'demo', actions: {} }),
		).request('/list', { method: 'POST' });

		const manifest = expectOk(
			(await res.json()) as Result<ActionManifest, never>,
		);
		expect(manifest).toEqual({});
	});

	test('returns actions from a mount without collaboration', async () => {
		const res = await buildDaemonApp(
			makeMount({
				mount: 'mirror',
				collaboration: false,
				actions: {
					sync: defineQuery({
						description: 'Sync local mirror',
						handler: () => null,
					}),
				},
			}),
		).request('/list', { method: 'POST' });

		const manifest = expectOk(
			(await res.json()) as Result<ActionManifest, never>,
		);
		expect(Object.keys(manifest)).toEqual(['mirror.sync']);
		expect(manifest['mirror.sync']?.description).toBe('Sync local mirror');
	});

	test('returns an empty manifest when the daemon has no active mount', async () => {
		const res = await buildDaemonApp(null).request('/list', {
			method: 'POST',
		});

		const manifest = expectOk(
			(await res.json()) as Result<ActionManifest, never>,
		);
		expect(manifest).toEqual({});
	});
});

describe('/peers route', () => {
	test('lists the connected devices for the collaborative mount', async () => {
		const res = await buildDaemonApp(
			makeMount({
				mount: 'notes',
				actions: {},
				devices: [{ deviceId: 'laptop', connectedAt: 1, actions: {} }],
			}),
		).request('/peers', { method: 'POST' });

		const peers = expectOk(
			(await res.json()) as Result<
				Array<{ mount: string; deviceId: string }>,
				never
			>,
		);
		expect(peers).toEqual([{ mount: 'notes', deviceId: 'laptop' }]);
	});

	test('returns no peers for a mount without collaboration', async () => {
		const res = await buildDaemonApp(
			makeMount({
				mount: 'mirror',
				collaboration: false,
				actions: {
					sync: defineQuery({ handler: () => null }),
				},
			}),
		).request('/peers', { method: 'POST' });

		const peers = expectOk(
			(await res.json()) as Result<
				Array<{ mount: string; deviceId: string }>,
				never
			>,
		);
		expect(peers).toEqual([]);
	});
});
