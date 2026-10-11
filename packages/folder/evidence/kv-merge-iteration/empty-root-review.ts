import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { prepareMerge } from '../../src//git/merge.ts';
import { writeCommitObject } from '../../src//git/objects.ts';

const root = await mkdtemp(join(tmpdir(), 'epicenter-empty-root-review-'));
try {
	await git.init({ fs, dir: root, defaultBranch: 'main' });
	const access = { fs, gitdir: join(root, '.git'), cache: {} };
	const author = { name: 'Review', email: 'review@localhost' };
	const empty = await git.writeTree({ ...access, tree: [] });
	const tree = await git.writeTree({
		...access,
		tree: [{ mode: '040000', type: 'tree', path: 'kv.json', oid: empty }],
	});
	const base = await writeCommitObject(access, {
		tree,
		parents: [],
		author,
		message: 'Empty root directory',
	});
	async function side(source: string) {
		const blob = await git.writeBlob({
			...access,
			blob: new TextEncoder().encode(source),
		});
		const tree = await git.writeTree({
			...access,
			tree: [{ mode: '100644', type: 'blob', path: 'kv.json', oid: blob }],
		});
		return writeCommitObject(access, {
			tree,
			parents: [base],
			author,
			message: 'Replace directory',
		});
	}
	const head = await side('{"a":1}');
	const fetched = await side('{"b":1}');
	const outcome = await prepareMerge(access, {
		base,
		head,
		fetched,
		author,
		message: 'Review merge',
	});
	console.log(
		JSON.stringify({
			baseRootEntry: (await git.readTree({ ...access, oid: tree })).tree[0],
			result: outcome.kind,
		}),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
