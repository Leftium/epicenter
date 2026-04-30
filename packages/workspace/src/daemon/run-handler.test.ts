/**
 * executeRun peer dispatch tests.
 *
 * Verifies the daemon normalizes sync-layer peer lookup misses into the
 * `/run` error union before the response crosses the IPC boundary.
 */

import { describe, expect, test } from 'bun:test';

import { PeerMiss, type SyncAttachment } from '../document/attach-sync.js';
import { defineQuery } from '../shared/actions.js';
import { executeRun } from './run-handler.js';
import type { WorkspaceEntry } from './types.js';

function fakeEntry(sync: Partial<SyncAttachment>): WorkspaceEntry {
	const workspace = {
		sync: sync as SyncAttachment,
		tabs: {
			list: defineQuery({
				handler: () => [],
			}),
		},
		[Symbol.dispose]() {},
	};

	return { name: 'demo', workspace: workspace as WorkspaceEntry['workspace'] };
}

describe('executeRun peer dispatch', () => {
	test('peer miss returns RunError.PeerMiss and skips rpc', async () => {
		let rpcCalls = 0;
		const entry = fakeEntry({
			async waitForPeer(deviceId, { timeoutMs }) {
				return PeerMiss.PeerMiss({
					peerTarget: deviceId,
					sawPeers: true,
					waitMs: timeoutMs,
					emptyReason: null,
				});
			},
			async rpc() {
				rpcCalls++;
				throw new Error('rpc should not be called');
			},
		});

		const result = await executeRun(entry, {
			actionPath: 'tabs.list',
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
});
