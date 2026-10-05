/**
 * Unfinished Merge Tests on Disk
 *
 * A Bun directory folder publishes a merge left for a person in Git's own
 * order of trust: `ORIG_HEAD`, `MERGE_MSG`, and `MERGE_HEAD` first, then the
 * files, then the index in one `update-index`. Each step is faulted against a
 * real repository; whatever lands, the folder never checkpoints conflict
 * markers and never records the resolution with one parent.
 *
 * Key behaviors:
 * - A merge state write that fails writes no file or index entry, and the
 *   merge is refused, never reported as published
 * - A file step that writes nothing removes the merge state again
 * - Files or an index that stop partway stay under the pinned merge: a
 *   whole-folder commit is blocked before and after reopening, and staging
 *   and a staged commit record both original parents
 * - Unmerged stages whose `MERGE_HEAD` is gone block a whole-folder commit
 * - A staged commit finishes the merge only from `ORIG_HEAD`: a branch moved
 *   before or during the commit is refused, and the index, the branch, and
 *   the merge state stay as they were
 *
 * See also:
 * - `merge-unfinished.test.ts` for the browser and the terminal journeys
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FileBoundary } from './boundary.js';
import type { GitBackend } from './git/backend.js';
import { createHistory } from './git/history.js';
import { writeCommitObject, writeFilesTree } from './git/objects.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';

const real = { ...realFs };
/** Private Git files whose replacement fails, when set. */
let failing: ((target: string) => boolean) | undefined;

// The native backend reads these bindings at call time, so a merge state
// write fails at its own rename without a production seam.
mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async rename(...args: Parameters<typeof real.rename>) {
		if (failing?.(String(args[1])))
			throw Object.assign(new Error('Injected rename failure'), {
				code: 'EIO',
			});
		return real.rename(...args);
	},
}));

const { createNativeFileBoundary } = await import('./native-store.js');
const { createNativeGitBackend } = await import('./git/native-backend.js');

const author = { name: 'Merger', email: 'merger@example.test' };
const encoder = new TextEncoder();
const MARKED = '<<<<<<< HEAD\nred\n=======\ngreen\n>>>>>>> origin/main\n';
const COLOR = {
	base: { 'notes/color.txt': 'blue\n', 'keep.md': 'keep\n' },
	ours: { 'notes/color.txt': 'red\n', 'keep.md': 'keep\n' },
	theirs: {
		'notes/color.txt': 'green\n',
		'keep.md': 'keep\n',
		'theirs.md': 'theirs\n',
	},
};

const roots: string[] = [];
const opened: { close(): Promise<void> }[] = [];
const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});
afterEach(async () => {
	failing = undefined;
	for (const made of opened.splice(0)) await made.close();
	for (const root of roots.splice(0))
		await real.rm(root, { recursive: true, force: true });
});

/**
 * A Bun directory folder in manual history. `apply` and `overrides` stand
 * in for another program acting while the folder publishes or commits.
 */
async function open(
	root: string,
	{
		apply,
		overrides = () => ({}),
	}: {
		apply?: (
			files: FileBoundary,
			changes: Parameters<FileBoundary['apply']>[0],
		) => ReturnType<FileBoundary['apply']>;
		overrides?: (real: GitBackend) => Partial<GitBackend>;
	} = {},
) {
	const files = createNativeFileBoundary(root);
	const boundary: FileBoundary =
		apply === undefined
			? files
			: { ...files, apply: (changes) => apply(files, changes) };
	const backend = await createNativeGitBackend({
		root,
		branch: 'main',
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		boundary,
	});
	const history = createHistory({
		backend: { ...backend, ...overrides(backend) },
		boundary,
		author,
		commitOnEdit: false,
	});
	opened.push(history);
	return { root, backend, history };
}

type Opened = Awaited<ReturnType<typeof open>>;

/** Diverge `root` as COLOR: ours committed here, theirs fetched. */
async function diverge(made: Opened) {
	const { root, backend, history } = made;
	const commitFiles = async (tree: Record<string, string>) => {
		for (const [path, value] of Object.entries(tree)) {
			await real.mkdir(join(root, path, '..'), { recursive: true });
			await real.writeFile(join(root, path), value);
		}
		const outcome = await history.commit();
		if (outcome.status !== 'committed') throw new Error(outcome.status);
		return outcome.oid;
	};
	const base = await commitFiles(COLOR.base);
	const theirs = await backend.withObjects(async (access) =>
		writeCommitObject(access, {
			tree: await writeFilesTree(
				access,
				new Map(
					Object.entries(COLOR.theirs).map(([path, value]) => [
						path,
						encoder.encode(value),
					]),
				),
			),
			parents: [base],
			message: 'Green',
			author,
		}),
	);
	const ours = await commitFiles(COLOR.ours);
	await git(root, 'update-ref', 'refs/remotes/origin/main', theirs);
	return { base, ours, theirs };
}

async function folder(options?: Parameters<typeof open>[1]) {
	const root = await scratch('unfinished-native-');
	roots.push(root);
	await git(root, 'init', '--quiet', '--initial-branch=main');
	const made = await open(root, options);
	return { ...made, sides: await diverge(made) };
}

/** Close `made` and open its directory again, with no faults. */
async function reopen(made: Opened) {
	await made.history.close();
	return open(made.root);
}

const readText = (root: string, path: string) =>
	real.readFile(join(root, path), 'utf8').catch(() => undefined);

/** The branch, the merge state, the index entries, and the authored files. */
async function state(root: string) {
	return {
		branch: await git(root, 'rev-parse', 'refs/heads/main'),
		mergeHead: await readText(root, '.git/MERGE_HEAD'),
		origHead: await readText(root, '.git/ORIG_HEAD'),
		index: await git(root, 'ls-files', '--stage'),
		color: await readText(root, 'notes/color.txt'),
		theirs: await readText(root, 'theirs.md'),
	};
}

async function parentsOf(root: string, commit: string) {
	return (await git(root, 'log', '-1', '--format=%P', commit)).split(' ');
}

for (const name of ['ORIG_HEAD', 'MERGE_MSG', 'MERGE_HEAD'])
	test(`a failed ${name} write publishes nothing and is not reported as a merge`, async () => {
		const made = await folder();
		const before = await state(made.root);
		failing = (target) => target.endsWith(`/.git/${name}`);

		expect(
			expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
		).toMatchObject({ name: 'Refused' });

		failing = undefined;
		const after = await state(made.root);
		// Only a head and a message may be left; no merge began.
		expect({ ...after, origHead: undefined }).toEqual({
			...before,
			origHead: undefined,
		});
		expect(after.mergeHead).toBeUndefined();
		expect(
			(await real.readdir(join(made.root, '.git'))).filter((entry) =>
				entry.includes('.tmp-'),
			),
		).toEqual([]);

		const reopened = await reopen(made);
		expect(reopened.history.snapshot.merging).toBeUndefined();
		expect(await reopened.history.commit()).toMatchObject({
			status: 'unchanged',
		});
		expectOk(await reopened.history.stage('all'));
		expect(expectErr(await reopened.history.commitStaged('Merge')).name).toBe(
			'NothingToCommit',
		);
		expect(await git(made.root, 'rev-parse', 'HEAD')).toBe(made.sides.ours);
	});

test('a file step that writes nothing removes the merge state it began with', async () => {
	const made = await folder({
		apply: async () => ({
			data: null,
			error: {
				name: 'Io',
				message: 'Injected file failure',
				path: 'notes/color.txt',
				operation: 'replace',
				cause: undefined,
			},
		}),
	});
	const before = await state(made.root);

	expect(
		expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({ name: 'Refused' });

	expect({ ...(await state(made.root)), origHead: undefined }).toEqual({
		...before,
		origHead: undefined,
	});
});

/**
 * After a publication stopped with files written and no stages: no
 * checkpoint takes the markers, before or after reopening, and the staged
 * resolution records both parents.
 */
async function finishesWithBothParents(
	made: Awaited<ReturnType<typeof folder>>,
) {
	const { root, sides } = made;
	expect(await readText(root, '.git/MERGE_HEAD')).toBe(`${sides.theirs}\n`);
	expect(await readText(root, '.git/ORIG_HEAD')).toBe(`${sides.ours}\n`);
	expect(await made.history.commit()).toMatchObject({ status: 'blocked' });

	const reopened = await reopen(made);
	expectOk(await reopened.history.status());
	expect(reopened.history.snapshot.merging).toEqual({
		incoming: sides.theirs,
		head: sides.ours,
		unresolved: [],
	});
	expect(await reopened.history.commit()).toMatchObject({ status: 'blocked' });
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(sides.ours);

	await real.writeFile(join(root, 'notes/color.txt'), 'green\n');
	expectOk(await reopened.history.stage('all'));
	const committed = expectOk(await reopened.history.commitStaged('Merge'));
	expect(committed.incoming).toBe(sides.theirs);
	expect(await parentsOf(root, committed.oid)).toEqual([
		sides.ours,
		sides.theirs,
	]);
	expect(await readText(root, '.git/MERGE_HEAD')).toBeUndefined();
}

test('files that stop partway stay under the pinned merge', async () => {
	let root = '';
	const made = await folder({
		async apply(files, changes) {
			// Another program takes a path the merge creates, after the first write.
			if (root !== '') await real.writeFile(join(root, 'theirs.md'), 'mine\n');
			return files.apply(changes);
		},
	});
	root = made.root;

	expect(
		expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({
		name: 'Partial',
		applied: [{ kind: 'write', path: 'notes/color.txt' }],
	});

	expect(await readText(root, 'notes/color.txt')).toBe(MARKED);
	expect(await git(root, 'ls-files', '--unmerged')).toBe('');
	await real.rm(join(root, 'theirs.md'));
	await finishesWithBothParents(made);
});

test('an index that cannot be written stays under the pinned merge', async () => {
	let root = '';
	const made = await folder({
		async apply(files, changes) {
			const applied = await files.apply(changes);
			// Another Git process holds the index.
			if (root !== '') await real.writeFile(join(root, '.git/index.lock'), '');
			return applied;
		},
	});
	root = made.root;
	const index = await git(root, 'ls-files', '--stage');

	expect(
		expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({ name: 'IndexFailed' });

	expect(await readText(root, 'notes/color.txt')).toBe(MARKED);
	expect(await git(root, 'ls-files', '--stage')).toBe(index);
	await real.rm(join(root, '.git/index.lock'));
	await finishesWithBothParents(made);
});

test('a published merge writes its index entries and stages together', async () => {
	const made = await folder();

	expect(
		expectOk(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({ status: 'conflicted' });

	const { root, sides } = made;
	expect(await git(root, 'ls-files', '--stage')).toBe(
		[
			`100644 ${await git(root, 'rev-parse', `${sides.ours}:keep.md`)} 0\tkeep.md`,
			`100644 ${await git(root, 'rev-parse', `${sides.base}:notes/color.txt`)} 1\tnotes/color.txt`,
			`100644 ${await git(root, 'rev-parse', `${sides.ours}:notes/color.txt`)} 2\tnotes/color.txt`,
			`100644 ${await git(root, 'rev-parse', `${sides.theirs}:notes/color.txt`)} 3\tnotes/color.txt`,
			`100644 ${await git(root, 'rev-parse', `${sides.theirs}:theirs.md`)} 0\ttheirs.md`,
		].join('\n'),
	);
	expect(await readText(root, 'notes/color.txt')).toBe(MARKED);
});

test('a whole-folder commit refuses unmerged stages whose MERGE_HEAD is gone', async () => {
	const made = await folder();
	expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));
	await real.rm(join(made.root, '.git/MERGE_HEAD'));

	const outcome = await made.history.commit();

	expect(outcome).toMatchObject({ status: 'blocked' });
	expect(outcome.status === 'blocked' && outcome.reason).toContain(
		'notes/color.txt has unmerged index stages',
	);
	expect(await git(made.root, 'rev-parse', 'HEAD')).toBe(made.sides.ours);
	expect(await readText(made.root, 'notes/color.txt')).toBe(MARKED);
});

/** A merge left in place, resolved and staged, and a sibling of its head. */
async function resolved(options?: Parameters<typeof open>[1]) {
	const made = await folder(options);
	expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));
	await real.writeFile(join(made.root, 'notes/color.txt'), 'green\n');
	expectOk(await made.history.stage('all'));
	const sibling = await git(
		made.root,
		'commit-tree',
		`${made.sides.base}^{tree}`,
		'-p',
		made.sides.base,
		'-m',
		'Another owner',
	);
	return { ...made, sibling };
}

test('a staged commit refuses a branch moved away from ORIG_HEAD and changes nothing', async () => {
	const made = await resolved();
	const { root, sides, sibling } = made;
	await git(root, 'update-ref', 'refs/heads/main', sibling, sides.ours);
	const before = await state(root);
	const index = await real.readFile(join(root, '.git/index'));

	expect(expectErr(await made.history.commitStaged('Merge'))).toMatchObject({
		name: 'BranchMoved',
		expected: sides.ours,
		actual: sibling,
	});

	expect(await state(root)).toEqual(before);
	expect(await real.readFile(join(root, '.git/index'))).toEqual(index);
});

test('a branch moved during the staged commit is refused by its compare-and-swap', async () => {
	let move: (() => Promise<unknown>) | undefined;
	const made = await resolved({
		overrides: (backend) => ({
			async commitIndex(...args) {
				await move?.();
				return backend.commitIndex(...args);
			},
		}),
	});
	const { root, sides, sibling } = made;
	const index = await real.readFile(join(root, '.git/index'));
	move = () => git(root, 'update-ref', 'refs/heads/main', sibling, sides.ours);

	expect(expectErr(await made.history.commitStaged('Merge'))).toMatchObject({
		name: 'BranchMoved',
		expected: sides.ours,
		actual: sibling,
	});

	expect(await git(root, 'rev-parse', 'HEAD')).toBe(sibling);
	expect(await readText(root, '.git/MERGE_HEAD')).toBe(`${sides.theirs}\n`);
	expect(await real.readFile(join(root, '.git/index'))).toEqual(index);
});
