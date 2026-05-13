/**
 * executeRun peer dispatch tests.
 *
 * Verifies the daemon preserves remote client errors in one `/run` envelope
 * before the response crosses the IPC boundary.
 */

import { describe, expect, test } from 'bun:test';

import { RpcError } from '@epicenter/sync';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { Workspace } from '../document/open-workspace.js';
import type { Peer, PeersSurface } from '../document/peer.js';
import type { Actions } from '../shared/actions.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import type { RunSyncStatus } from './run-errors.js';
import { executeRun } from './run-handler.js';
import type { StartedDaemonRoute } from './types.js';

type FakeInvoke = (
	peerTarget: string,
	action: string,
	input: unknown,
	options?: { timeout?: number },
) => Promise<{ data: unknown; error: unknown }>;

function fakePeer({
	peerId,
	invoke,
}: {
	peerId: string;
	invoke: FakeInvoke;
}): Peer {
	return {
		id: peerId,
		identity: { id: peerId, name: peerId, platform: 'node' },
		clientID: 1,
		actionPaths: [],
		invoke: (action, input, options) =>
			invoke(peerId, action, input, options) as never,
		describe: async () => ({ data: {}, error: null }) as never,
	};
}

function fakePeers({
	known,
	invoke,
}: {
	known: string[];
	invoke: FakeInvoke;
}): PeersSurface {
	return {
		list: () => known.map((peerId) => fakePeer({ peerId, invoke })),
		find: (peerId) =>
			known.includes(peerId) ? fakePeer({ peerId, invoke }) : undefined,
		observe: () => () => {},
	};
}

function fakeWorkspace<TActions extends Actions>({
	actions,
	syncStatus = { phase: 'connected' },
	peers,
}: {
	actions: TActions;
	syncStatus?: SyncStatus;
	peers: PeersSurface;
}): Workspace<TActions> {
	const ydoc = new Y.Doc();
	return {
		identity: { id: 'self', name: 'Self', platform: 'node' },
		actions,
		awareness: new Awareness(ydoc),
		status: syncStatus,
		whenConnected: Promise.resolve(),
		whenDisposed: Promise.resolve(),
		onStatusChange: () => () => {},
		reconnect() {},
		goOffline() {},
		peers,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	} as Workspace<TActions>;
}

function fakeEntry({
	actions = {
		tabs: {
			list: defineQuery({ handler: () => [] }),
		},
	},
	syncStatus,
	knownPeers = [],
	invoke = async () => ({ data: null, error: null }),
}: {
	actions?: Actions;
	syncStatus?: SyncStatus;
	knownPeers?: string[];
	invoke?: FakeInvoke;
} = {}): StartedDaemonRoute {
	const peers = fakePeers({ known: knownPeers, invoke });
	const workspace = fakeWorkspace({ actions, syncStatus, peers });
	return {
		route: 'demo',
		runtime: {
			workspace,
			async [Symbol.asyncDispose]() {},
		},
	};
}

describe('executeRun peer dispatch', () => {
	test('peer miss returns RunError.RemoteCallFailed with sync status', async () => {
		const syncStatus: SyncStatus = {
			phase: 'connecting',
			retries: 2,
			lastError: { type: 'connection' },
		};
		const runSyncStatus = {
			phase: 'connecting',
			retries: 2,
			lastErrorType: 'connection',
		} satisfies RunSyncStatus;
		const entry = fakeEntry({ syncStatus, knownPeers: [] });

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'ghost',
			waitMs: 25,
		});

		expect(result.error).not.toBeNull();
		if (result.error === null) throw new Error('expected RemoteCallFailed');
		expect(result.error.name).toBe('RemoteCallFailed');
		if (result.error.name !== 'RemoteCallFailed') {
			throw new Error(`expected RemoteCallFailed, got ${result.error.name}`);
		}
		expect(result.error.peerTarget).toBe('ghost');
		expect(result.error.syncStatus).toEqual(runSyncStatus);
		expect(result.error.cause).toMatchObject({
			name: 'PeerNotFound',
			peerTarget: 'ghost',
		});
	});

	test('remote dispatch sends only the inner action path', async () => {
		let invokedAction = '';
		const entry = fakeEntry({
			knownPeers: ['mac'],
			invoke: async (_peerId, action) => {
				invokedAction = action;
				return { data: [], error: null };
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(invokedAction).toBe('tabs.list');
	});

	test('remote dispatch surfaces RpcError unchanged', async () => {
		const entry = fakeEntry({
			knownPeers: ['mac'],
			invoke: async () => RpcError.Timeout({ ms: 25 }),
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expect(result.error?.name).toBe('RemoteCallFailed');
		if (result.error?.name !== 'RemoteCallFailed') {
			throw new Error('expected RemoteCallFailed');
		}
		expect(result.error.cause).toMatchObject({ name: 'Timeout', ms: 25 });
	});
});

describe('executeRun route-prefixed routing', () => {
	test('invokes action under the selected daemon route', async () => {
		const entry = fakeEntry({
			actions: {
				notes: {
					add: defineMutation({
						handler: () => ({ body: 'hello' }),
					}),
				},
			},
		});
		entry.route = 'notes';

		const result = await executeRun([entry], {
			actionPath: 'notes.notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ body: 'hello' });
	});

	test('missing path suggests action-root-relative sibling', async () => {
		const entry = fakeEntry({
			actions: {
				notes: {
					add: defineMutation({
						handler: () => ({ body: 'hello' }),
					}),
				},
			},
		});
		entry.route = 'notes';

		const result = await executeRun([entry], {
			actionPath: 'notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error?.name).toBe('UsageError');
		if (result.error?.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(result.error.suggestions).toEqual(['  notes.notes.add  (mutation)']);
	});

	test('unknown route returns available route suggestions', async () => {
		const result = await executeRun(
			[
				fakeEntry({}),
				(() => {
					const tasks = fakeEntry({ actions: {} });
					tasks.route = 'tasks';
					return tasks;
				})(),
			],
			{
				actionPath: 'missing.actions.add',
				input: undefined,
				waitMs: 25,
			},
		);

		expect(result.error?.name).toBe('UsageError');
		if (result.error?.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(result.error.message).toBe(
			'No daemon route "missing". Available: demo, tasks',
		);
		expect(result.error.suggestions).toEqual(['  demo', '  tasks']);
	});
});
