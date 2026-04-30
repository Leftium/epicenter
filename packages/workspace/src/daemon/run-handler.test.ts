/**
 * executeRun peer dispatch tests.
 *
 * Verifies the daemon normalizes presence peer lookup misses into the
 * `/run` error union before the response crosses the IPC boundary.
 */

import { describe, expect, test } from 'bun:test';

import { PeerMiss, type SyncRpcAttachment } from '../document/attach-sync.js';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { executeRun } from './run-handler.js';
import type { WorkspaceEntry } from './types.js';

function fakeEntry(
	presence: Partial<PeerPresenceAttachment> = {},
	rpc: Partial<SyncRpcAttachment> = {},
): WorkspaceEntry {
	const workspace = {
		actions: {
			tabs: {
				list: defineQuery({
					handler: () => [],
				}),
			},
		},
		presence: presence as PeerPresenceAttachment,
		rpc: rpc as SyncRpcAttachment,
		[Symbol.dispose]() {},
	};

	return { name: 'demo', workspace: workspace as WorkspaceEntry['workspace'] };
}

describe('executeRun peer dispatch', () => {
	test('peer miss returns RunError.PeerMiss and skips rpc', async () => {
		let rpcCalls = 0;
		const entry = fakeEntry(
			{
				async waitForPeer(peerId, { timeoutMs }) {
					return PeerMiss.PeerMiss({
						peerTarget: peerId,
						sawPeers: true,
						waitMs: timeoutMs,
						emptyReason: null,
					});
				},
			},
			{
				async rpc() {
					rpcCalls++;
					throw new Error('rpc should not be called');
				},
			},
		);

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'ghost',
			waitMs: 25,
		});

		expect(rpcCalls).toBe(0);
		expect(result.error).not.toBeNull();
		if (result.error === null) throw new Error('expected PeerMiss');
		expect(result.error.name).toBe('PeerMiss');
		if (result.error.name !== 'PeerMiss') {
			throw new Error(`expected PeerMiss, got ${result.error.name}`);
		}
		expect(result.error.peerTarget).toBe('ghost');
		expect(result.error.sawPeers).toBe(true);
		expect(result.error.waitMs).toBe(25);
		expect(result.error.emptyReason).toBeNull();
	});

	test('remote dispatch sends only the inner action path', async () => {
		let rpcAction = '';
		const entry = fakeEntry(
			{
				async waitForPeer() {
					return {
						data: {
							clientId: 42,
							state: { peer: { id: 'mac', name: 'Mac', platform: 'node' } },
						},
						error: null,
					};
				},
			},
			{
				async rpc(_clientId, action) {
					rpcAction = action;
					return { data: [], error: null };
				},
			},
		);

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(rpcAction).toBe('tabs.list');
	});
});

describe('executeRun export-prefixed routing', () => {
	test('invokes action under the selected config export', async () => {
		const workspace = {
			actions: {
				notes: {
					add: defineMutation({
						handler: () => ({ body: 'hello' }),
					}),
				},
			},
			[Symbol.dispose]() {},
		};
		const entry = {
			name: 'notes',
			workspace: workspace as WorkspaceEntry['workspace'],
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ body: 'hello' });
	});

	test('ignores action leaves outside the canonical action root', async () => {
		const workspace = {
			actions: {},
			notes: {
				add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
			[Symbol.dispose]() {},
		};
		const entry = {
			name: 'notes',
			workspace: workspace as WorkspaceEntry['workspace'],
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error?.name).toBe('UsageError');
	});

	test('missing path suggests action-root-relative sibling', async () => {
		const entry = {
			name: 'notes',
			workspace: {
				actions: {
					notes: {
						add: defineMutation({
							handler: () => ({ body: 'hello' }),
						}),
					},
				},
				[Symbol.dispose]() {},
			} as WorkspaceEntry['workspace'],
		};

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

	test('unknown export returns available export suggestions', async () => {
		const result = await executeRun(
			[
				fakeEntry({}),
				{
					name: 'tasks',
					workspace: {
						actions: {},
						[Symbol.dispose]() {},
					} as WorkspaceEntry['workspace'],
				},
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
			'No config export "missing". Available: demo, tasks',
		);
		expect(result.error.suggestions).toEqual(['  demo', '  tasks']);
	});
});
