/**
 * End-to-end reconcile: two peers converge through Yjs.
 *
 * This is the two-vault scenario compressed into one process. Two independent
 * workspaces (peer A, peer B) are wired so each Yjs update flows to the other,
 * exactly as the relay would carry it between two machines. Each peer
 * materializes the same workspace to its own directory.
 *
 * The proof: edit markdown in peer A's directory, run `markdown_apply` on A,
 * and peer B's directory converges to byte-identical output without any direct
 * file copy. That single assertion exercises the whole loop:
 *
 *   apply (disk -> Yjs)  ->  Yjs update propagates  ->  B re-materializes (Yjs -> disk)
 *   ->  deterministic output means dirA == dirB
 *
 * No relay, no cloud, no auth: the wire is `Y.applyUpdate`. If this converges,
 * the real two-vault case converges too, because the only added piece there is
 * a network in place of the function call.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { createWorkspace, defineTable } from '../../../index.js';
import { column } from '../../column/index.js';
import { attachMarkdownMaterializer } from './materializer.js';

const postsTable = defineTable({
	id: column.string(),
	title: column.string(),
	tags: column.json(Type.Array(Type.String())),
	published: column.boolean(),
});

const tableDefinitions = { posts: postsTable };

const ROOT = join(import.meta.dir, '__test-e2e__');
const DIR_A = join(ROOT, 'peer-a');
const DIR_B = join(ROOT, 'peer-b');

beforeEach(async () => {
	await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
	await rm(ROOT, { recursive: true, force: true });
});

/** Read a peer's posts directory into a `{ filename: content }` map. */
async function readTree(dir: string): Promise<Record<string, string>> {
	const postsDir = join(dir, 'posts');
	let names: string[];
	try {
		names = (await readdir(postsDir)).filter((n) => n.endsWith('.md'));
	} catch {
		return {};
	}
	const tree: Record<string, string> = {};
	for (const name of names.sort()) {
		// Tolerate a file vanishing between readdir and readFile: the daemon's
		// observer may unlink mid-snapshot. The convergence waitUntil retries, so
		// a transient skip just means this poll sees an in-between state.
		try {
			tree[name] = await readFile(join(postsDir, name), 'utf-8');
		} catch {
			// skip; next poll re-reads a consistent directory
		}
	}
	return tree;
}

/** Poll until `predicate()` holds or the deadline passes. */
async function waitUntil(
	predicate: () => Promise<boolean>,
	{ timeoutMs = 3000, stepMs = 25 } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	throw new Error('waitUntil: predicate never became true');
}

async function treeKeys(dir: string): Promise<string[]> {
	return Object.keys(await readTree(dir)).sort();
}

/** Two workspaces wired so every update on one is applied to the other. */
async function setupPeers() {
	const a = createWorkspace({ id: 'e2e', tables: tableDefinitions, kv: {} });
	const b = createWorkspace({ id: 'e2e', tables: tableDefinitions, kv: {} });

	// The "relay": forward updates both ways. The origin sentinel stops the echo.
	const SYNC = 'peer-sync';
	a.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
		if (origin !== SYNC) Y.applyUpdate(b.ydoc, update, SYNC);
	});
	b.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
		if (origin !== SYNC) Y.applyUpdate(a.ydoc, update, SYNC);
	});

	const matA = attachMarkdownMaterializer(a, {
		dir: DIR_A,
		perTable: { posts: {} },
	});
	const matB = attachMarkdownMaterializer(b, {
		dir: DIR_B,
		perTable: { posts: {} },
	});
	await Promise.all([matA.whenFlushed, matB.whenFlushed]);

	return { a, b, matA, matB };
}

describe('two-peer reconcile convergence', () => {
	test('an apply on peer A converges peer B byte-for-byte', async () => {
		const { a, b, matA } = await setupPeers();

		// Seed shared state through A; it propagates to B.
		a.tables.posts.set({ id: 'a', title: 'Alpha', tags: ['x'], published: true });
		a.tables.posts.set({ id: 'b', title: 'Beta', tags: [], published: true });
		a.tables.posts.set({ id: 'c', title: 'Gamma', tags: ['y'], published: true });

		// Wait until BOTH peers are fully materialized before editing. We edit and
		// apply against DIR_A, so DIR_A must have all three files first, or apply
		// would read a half-written directory and plan a spurious delete.
		await waitUntil(async () => b.tables.posts.count() === 3);
		await waitUntil(async () => (await treeKeys(DIR_A)).length === 3);
		await waitUntil(async () => (await treeKeys(DIR_B)).length === 3);

		// "Agent" edits peer A's directory: edit one, remove one, add one.
		const beta = join(DIR_A, 'posts', 'b.md');
		await writeFile(
			beta,
			(await readFile(beta, 'utf-8')).replace('title: Beta', 'title: Beta EDITED'),
			'utf-8',
		);
		await rm(join(DIR_A, 'posts', 'c.md'));
		await writeFile(
			join(DIR_A, 'posts', 'd.md'),
			'---\nid: d\ntitle: Delta\ntags: []\npublished: false\n---\n',
			'utf-8',
		);

		// Reconcile A's disk into A's Yjs. This is the only action taken.
		const plan = await matA.actions.markdown_apply({});
		expect(plan.refused).toBe(false);
		expect(plan.updates.map((u) => u.id)).toEqual(['b']);
		expect(plan.deletes.map((x) => x.id)).toEqual(['c']);
		expect(plan.creates.map((c) => c.id)).toEqual(['d']);

		// The far side converges through Yjs alone, no file copy. Gate on the
		// PRECISE end state (b edited, c gone, d created) in peer B's OWN Y.Doc,
		// so the wait can't pass at the stale a/b/c state.
		await waitUntil(async () => {
			const beta = b.tables.posts.get('b').data;
			return (
				b.tables.posts.count() === 3 &&
				!b.tables.posts.has('c') &&
				b.tables.posts.has('d') &&
				beta?.title === 'Beta EDITED'
			);
		});
		// Both directories converge to byte-identical canonical output. Peer A
		// re-materializes its own dir from Yjs after apply (async, overwriting the
		// hand-edited files), so wait for BOTH sides to settle and agree, not just B.
		await waitUntil(async () => {
			const [a, b] = await Promise.all([readTree(DIR_A), readTree(DIR_B)]);
			return (
				Object.keys(b).join() === 'a.md,b.md,d.md' &&
				JSON.stringify(a) === JSON.stringify(b)
			);
		});

		const [treeA, treeB] = await Promise.all([readTree(DIR_A), readTree(DIR_B)]);
		expect(Object.keys(treeB).sort()).toEqual(['a.md', 'b.md', 'd.md']);
		expect(treeB).toEqual(treeA);
		expect(treeB['b.md']).toContain('Beta EDITED');
	});
});
