/**
 * Multi-Client Compaction Tests
 *
 * Verifies epoch transition coordination between multiple workspace
 * clients connected via Y.Doc sync. When one client compacts, others
 * detect the epoch change via the coordination doc and transition automatically.
 *
 * Key behaviors:
 * - Remote client detects epoch bump via coordination doc observation
 * - Remote client transitions to new data doc without data loss
 * - Concurrent compaction by two clients converges safely
 *
 * Note: These are skeleton tests. The bodies are left empty because
 * full multi-client testing requires sync infrastructure (shared Y.Doc
 * providers, coordination doc exchange) that is out of scope for unit tests.
 */

import { describe, test } from 'bun:test';
import { type } from 'arktype';
import { createWorkspace } from './create-workspace.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './define-workspace.js';

function setupPeer(workspaceId: string) {
	const postsTable = defineTable(
		type({ id: 'string', title: 'string', _v: '1' }),
	);
	const definition = defineWorkspace({
		id: workspaceId,
		tables: { posts: postsTable },
	});
	return createWorkspace(definition);
}

describe('multi-client compaction', () => {
	test('peer B sees epoch change after peer A compacts and syncs coordination doc', () => {
		// 1. Both clients on epoch 0
		// 2. Client A compacts → epoch 1
		// 3. Sync coordination docs
		// 4. Client B detects epoch change
		// 5. Client B transitions to epoch 1
	});

	test('concurrent compaction: both peers bump to same epoch', () => {
		// 1. A and B both on epoch 0
		// 2. Both compact simultaneously → both write epoch 1
		// 3. Sync coordination docs
		// 4. Both converge to epoch 1 (per-client MAX)
	});

	test('data written by peer A before compact is visible to peer B after transition', () => {
		// 1. A writes post '1'
		// 2. A compacts (post '1' included in snapshot)
		// 3. B transitions to new epoch
		// 4. B can read post '1'
	});
});
