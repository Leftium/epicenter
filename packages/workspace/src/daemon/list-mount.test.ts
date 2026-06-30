/**
 * Coverage for the `/list` manifest projection.
 *
 * `/list` describes the one hosted mount with a mount label and bare action
 * keys. The mount label is a display header for clients such as the CLI;
 * actions are addressed by their bare key on the wire and in the CLI alike.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { Peer } from '../document/presence-protocol.js';
import {
	type ActionManifest,
	type ActionRegistry,
	defineQuery,
} from '../shared/actions.js';
import { buildDaemonApp } from './app.js';
import type { DaemonServedMount } from './types.js';

function makeMount({
	mount,
	actions,
	collaboration = true,
	peers = [],
}: {
	mount: string;
	actions: ActionRegistry;
	collaboration?: boolean;
	peers?: Peer[];
}): DaemonServedMount {
	const runtime: DaemonServedMount['runtime'] = { actions };
	if (collaboration) {
		runtime.collaboration = {
			peers: {
				list: () => peers,
			},
		};
	}
	return {
		mount,
		runtime,
	};
}

describe('/list route', () => {
	test('returns the mount label and bare action keys', async () => {
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

		const snapshot = expectOk(
			(await res.json()) as Result<
				{ mount: string; actions: ActionManifest },
				never
			>,
		);
		expect(snapshot.mount).toBe('demo');
		expect(Object.keys(snapshot.actions).sort()).toEqual(['counter_get']);
		expect(snapshot.actions.counter_get?.description).toBe('Read the counter');
	});

	test('returns an empty manifest when the mount has no actions', async () => {
		const res = await buildDaemonApp(
			makeMount({ mount: 'demo', actions: {} }),
		).request('/list', { method: 'POST' });

		const snapshot = expectOk(
			(await res.json()) as Result<
				{ mount: string; actions: ActionManifest },
				never
			>,
		);
		expect(snapshot).toEqual({ mount: 'demo', actions: {} });
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

		const snapshot = expectOk(
			(await res.json()) as Result<
				{ mount: string; actions: ActionManifest },
				never
			>,
		);
		expect(Object.keys(snapshot.actions)).toEqual(['sync']);
		expect(snapshot.actions.sync?.description).toBe('Sync local mirror');
	});
});

describe('/peers route', () => {
	test('returns no peers when the mount has no collaboration', async () => {
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
			(await res.json()) as Result<Array<{ nodeId: string }>, never>,
		);
		expect(peers).toEqual([]);
	});

	test('returns bare peer node ids', async () => {
		const res = await buildDaemonApp(
			makeMount({
				mount: 'notes',
				actions: {},
				peers: [{ nodeId: 'laptop', connectedAt: 1, actions: {} }],
			}),
		).request('/peers', { method: 'POST' });

		const peers = expectOk(
			(await res.json()) as Result<Array<{ nodeId: string }>, never>,
		);
		expect(peers).toEqual([{ nodeId: 'laptop' }]);
	});
});
