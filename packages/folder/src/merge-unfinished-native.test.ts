/**
 * Unfinished Merge Tests on Disk
 *
 * A Bun directory folder publishes a merge left for a person with everything
 * its commit depends on in place before any authored file: `ORIG_HEAD` and
 * `MERGE_MSG`, the whole index (incoming entries and conflict stages) in one
 * `update-index`, `MERGE_HEAD`, and only then the files. Each step is
 * faulted against a real repository; whatever lands, the folder never
 * checkpoints conflict markers, never records the resolution with one
 * parent, and never commits the local tree as the merge.
 *
 * Key behaviors:
 * - An `ORIG_HEAD`, `MERGE_MSG`, or index write that fails changes no file,
 *   leaves the index byte for byte as it was, and is refused, never reported
 *   as merged
 * - Nothing is rolled back once the index holds the merge, so a file another
 *   program staged meanwhile survives every failure after it
 * - A failed `MERGE_HEAD` write is `Partial` with no file step: the stages
 *   and incoming entries stay, both commits refuse them, reopening changes
 *   nothing, and the full incoming commit that `MERGE_MSG` names, written
 *   to `MERGE_HEAD` after the tracking ref moved on, finishes the merge
 *   with its original parents
 * - A first file write that writes nothing is `Partial` with no file step,
 *   and the merge stays in progress with its stages and incoming entries
 * - Files that stop partway stay under the pinned merge with its real
 *   unresolved paths: a staged commit with nothing staged is `Unmerged`,
 *   before and after reopening, and the merge commit keeps the fetched
 *   files the folder never got to write
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
/** Runs before a file is renamed into place: another program acting then. */
let renaming: ((target: string) => Promise<void>) | undefined;
/** Private Git files whose replacement fails, when set. */
let failing: ((target: string) => boolean) | undefined;

// The native backend reads these bindings at call time, so a merge state
// write fails at its own rename, and another program can act just before
// it, without a production seam.
mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async rename(...args: Parameters<typeof real.rename>) {
		await renaming?.(String(args[1]));
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
	renaming = undefined;
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

/**
 * The branch, the merge state, the exact index bytes and their entries, and
 * the authored files.
 */
async function state(root: string) {
	return {
		branch: await git(root, 'rev-parse', 'refs/heads/main'),
		mergeHead: await readText(root, '.git/MERGE_HEAD'),
		origHead: await readText(root, '.git/ORIG_HEAD'),
		index: await git(root, 'ls-files', '--stage'),
		indexBytes: (await real.readFile(join(root, '.git/index'))).toString(
			'base64',
		),
		color: await readText(root, 'notes/color.txt'),
		theirs: await readText(root, 'theirs.md'),
	};
}

async function parentsOf(root: string, commit: string) {
	return (await git(root, 'log', '-1', '--format=%P', commit)).split(' ');
}

/**
 * A refused merge left the folder as `before`, except perhaps a harmless
 * `ORIG_HEAD`, and a reopened folder has no merge to finish.
 */
async function nothingPublished(
	made: Awaited<ReturnType<typeof folder>>,
	before: Awaited<ReturnType<typeof state>>,
) {
	const after = await state(made.root);
	expect({ ...after, origHead: undefined }).toEqual({
		...before,
		origHead: undefined,
	});
	expect(after.mergeHead).toBeUndefined();
	expect(
		(await real.readdir(join(made.root, '.git'))).filter(
			(entry) => entry.includes('.tmp-') || entry === 'index.lock',
		),
	).toEqual([]);

	const reopened = await reopen(made);
	expectOk(await reopened.history.status());
	expect(reopened.history.snapshot.merging).toBeUndefined();
	expect(await reopened.history.commit()).toMatchObject({
		status: 'unchanged',
	});
	expectOk(await reopened.history.stage('all'));
	expect(expectErr(await reopened.history.commitStaged('Merge')).name).toBe(
		'NothingToCommit',
	);
	expect(await git(made.root, 'rev-parse', 'HEAD')).toBe(made.sides.ours);
}

for (const name of ['ORIG_HEAD', 'MERGE_MSG'])
	test(`a failed ${name} write publishes nothing and is not reported as a merge`, async () => {
		const made = await folder();
		const before = await state(made.root);
		failing = (target) => target.endsWith(`/.git/${name}`);

		expect(
			expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
		).toMatchObject({ name: 'Refused' });

		failing = undefined;
		await nothingPublished(made, before);
	});

test('an index the merge cannot write refuses it before any file', async () => {
	const made = await folder();
	// Another Git process holds the index.
	await real.writeFile(join(made.root, '.git/index.lock'), '');
	const before = await state(made.root);

	expect(
		expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({ name: 'Refused', error: { path: '.git/index' } });

	await real.rm(join(made.root, '.git/index.lock'));
	await nothingPublished(made, before);
});

/** Another program saves and stages a file the merge does not touch. */
async function stageOutside(root: string) {
	await real.writeFile(join(root, 'extra.md'), 'outside\n');
	await git(root, 'add', 'extra.md');
}

/**
 * The index a prepared merge holds: the incoming entries, each conflict's
 * three stages, and, when another program staged it, `extra.md`.
 */
async function preparedIndex(
	root: string,
	sides: { base: string; ours: string; theirs: string },
	{ outside }: { outside: boolean },
) {
	const blob = (spec: string) => git(root, 'rev-parse', spec);
	return [
		...(outside
			? [`100644 ${await git(root, 'hash-object', 'extra.md')} 0\textra.md`]
			: []),
		`100644 ${await blob(`${sides.ours}:keep.md`)} 0\tkeep.md`,
		`100644 ${await blob(`${sides.base}:notes/color.txt`)} 1\tnotes/color.txt`,
		`100644 ${await blob(`${sides.ours}:notes/color.txt`)} 2\tnotes/color.txt`,
		`100644 ${await blob(`${sides.theirs}:notes/color.txt`)} 3\tnotes/color.txt`,
		`100644 ${await blob(`${sides.theirs}:theirs.md`)} 0\ttheirs.md`,
	].join('\n');
}

/**
 * Resolve the conflict, stage only it, and commit: the merge commit has the
 * original parents and keeps the incoming file and the outside stage, though
 * neither was ever written by the merge.
 */
async function finishResolved(
	made: Opened,
	sides: { ours: string; theirs: string },
) {
	const { root, history } = made;
	await real.writeFile(join(root, 'notes/color.txt'), 'green\n');
	expectOk(await history.stage(['notes/color.txt']));
	const committed = expectOk(await history.commitStaged('Merge'));
	expect(committed.incoming).toBe(sides.theirs);
	expect(await parentsOf(root, committed.oid)).toEqual([
		sides.ours,
		sides.theirs,
	]);
	expect(await git(root, 'rev-parse', `${committed.oid}:theirs.md`)).toBe(
		await git(root, 'rev-parse', `${sides.theirs}:theirs.md`),
	);
	expect(await git(root, 'show', `${committed.oid}:extra.md`)).toBe('outside');
	expect(await readText(root, '.git/MERGE_HEAD')).toBeUndefined();
}

test('a failed MERGE_HEAD write keeps the prepared index, and the full incoming commit in MERGE_MSG repairs it', async () => {
	const made = await folder();
	const { root, sides } = made;
	// Another program stages a file after the merge began, before its index.
	renaming = async (target) => {
		if (target.endsWith('/.git/MERGE_MSG')) await stageOutside(root);
	};
	failing = (target) => target.endsWith('/.git/MERGE_HEAD');

	const stopped = expectErr(
		await made.history.mergeIncoming({ conflicts: 'leave' }),
	);

	renaming = undefined;
	failing = undefined;
	// The outside stage survives with the prepared merge.
	expect(await git(root, 'ls-files', '--stage')).toBe(
		await preparedIndex(root, sides, { outside: true }),
	);
	expect(stopped).toMatchObject({
		name: 'Partial',
		applied: [],
		error: { path: '.git/MERGE_HEAD' },
	});
	expect(stopped.message).toContain(sides.theirs);
	expect(stopped.message).toContain('MERGE_MSG');
	expect(await readText(root, '.git/MERGE_HEAD')).toBeUndefined();
	expect(await readText(root, '.git/ORIG_HEAD')).toBe(`${sides.ours}\n`);
	const message = await readText(root, '.git/MERGE_MSG');
	expect(message).toBe(
		`Merge remote-tracking branch 'origin/main'\n\n# Incoming commit: ${sides.theirs}\n`,
	);
	expect(await readText(root, 'notes/color.txt')).toBe('red\n');
	expect(await readText(root, 'theirs.md')).toBeUndefined();

	// Stages with no MERGE_HEAD: neither commit takes them.
	const blocked = await made.history.commit();
	expect(blocked.status === 'blocked' && blocked.reason).toContain(
		'notes/color.txt has unmerged index stages',
	);
	expect(expectErr(await made.history.commitStaged('Merge')).name).toBe(
		'Failed',
	);
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(sides.ours);

	// Reopening reads it again and changes nothing.
	const before = await state(root);
	const reopened = await reopen(made);
	expectOk(await reopened.history.status());
	expect(reopened.history.snapshot.merging).toBeUndefined();
	expect(await state(root)).toEqual(before);
	expect(await readText(root, '.git/MERGE_MSG')).toBe(message);

	// The tracking ref moves on; MERGE_MSG still names the merge's commit.
	await git(root, 'update-ref', 'refs/remotes/origin/main', sides.base);
	const named = /^# Incoming commit: ([0-9a-f]{40})$/m.exec(message ?? '')?.[1];
	expect(named).toBe(sides.theirs);
	await real.writeFile(join(root, '.git/MERGE_HEAD'), `${named}\n`);
	expectOk(await reopened.history.status());
	expect(reopened.history.snapshot.merging).toEqual({
		incoming: sides.theirs,
		head: sides.ours,
		unresolved: ['notes/color.txt'],
	});
	await finishResolved(reopened, sides);
});

test('a first file write that writes nothing keeps the merge in progress', async () => {
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
	const { root, sides } = made;
	// Another program stages a file once the merge's index is written.
	renaming = async (target) => {
		if (target.endsWith('/.git/MERGE_HEAD')) await stageOutside(root);
	};

	expect(
		expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({
		name: 'Partial',
		applied: [],
		error: { name: 'Io', path: 'notes/color.txt' },
	});

	renaming = undefined;
	expect(await readText(root, '.git/MERGE_HEAD')).toBe(`${sides.theirs}\n`);
	expect(await readText(root, '.git/ORIG_HEAD')).toBe(`${sides.ours}\n`);
	expect(await git(root, 'ls-files', '--stage')).toBe(
		await preparedIndex(root, sides, { outside: true }),
	);
	expect(await readText(root, 'notes/color.txt')).toBe('red\n');
	expect(await readText(root, 'theirs.md')).toBeUndefined();
	expectOk(await made.history.status());
	expect(made.history.snapshot.merging).toEqual({
		incoming: sides.theirs,
		head: sides.ours,
		unresolved: ['notes/color.txt'],
	});
	expect(expectErr(await made.history.commitStaged('Merge')).name).toBe(
		'Unmerged',
	);
	expect(await made.history.commit()).toMatchObject({ status: 'blocked' });
	// Staged and unstaged differences show what the files never got.
	expect((await git(root, 'status', '--porcelain')).split('\n').sort()).toEqual(
		['A  extra.md', 'AD theirs.md', 'UU notes/color.txt'],
	);

	const before = await state(root);
	const reopened = await reopen(made);
	expectOk(await reopened.history.status());
	expect(await state(root)).toEqual(before);
	expect(reopened.history.snapshot.merging?.unresolved).toEqual([
		'notes/color.txt',
	]);
	await finishResolved(reopened, sides);
});

test('files that stop partway leave the merge unresolved, and its commit keeps the fetched files', async () => {
	let root = '';
	const made = await folder({
		async apply(files, changes) {
			// Another program saves a path the merge creates, before it is written.
			if (root !== '') await real.writeFile(join(root, 'theirs.md'), 'mine\n');
			return files.apply(changes);
		},
	});
	root = made.root;
	const { sides } = made;

	expect(
		expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({
		name: 'Partial',
		applied: [{ kind: 'write', path: 'notes/color.txt' }],
	});

	expect(await readText(root, 'notes/color.txt')).toBe(MARKED);
	expect(await readText(root, '.git/MERGE_HEAD')).toBe(`${sides.theirs}\n`);
	expect(await readText(root, '.git/ORIG_HEAD')).toBe(`${sides.ours}\n`);
	expectOk(await made.history.status());
	expect(made.history.snapshot.merging).toEqual({
		incoming: sides.theirs,
		head: sides.ours,
		unresolved: ['notes/color.txt'],
	});
	// Nothing staged: no commit, and no checkpoint of the markers.
	expect(expectErr(await made.history.commitStaged('Merge'))).toMatchObject({
		name: 'Unmerged',
		paths: ['notes/color.txt'],
	});
	expect(await made.history.commit()).toMatchObject({ status: 'blocked' });

	const reopened = await reopen(made);
	expectOk(await reopened.history.status());
	expect(reopened.history.snapshot.merging?.unresolved).toEqual([
		'notes/color.txt',
	]);
	expect(expectErr(await reopened.history.commitStaged('Merge')).name).toBe(
		'Unmerged',
	);
	expect(await reopened.history.commit()).toMatchObject({ status: 'blocked' });
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(sides.ours);
	// The fetched file is in the index; the saved file stays as it was saved.
	expect((await git(root, 'status', '--porcelain')).split('\n').sort()).toEqual(
		['AM theirs.md', 'UU notes/color.txt'],
	);

	await real.writeFile(join(root, 'notes/color.txt'), 'green\n');
	expectOk(await reopened.history.stage(['notes/color.txt']));
	const committed = expectOk(await reopened.history.commitStaged('Merge'));

	expect(await parentsOf(root, committed.oid)).toEqual([
		sides.ours,
		sides.theirs,
	]);
	expect(await git(root, 'rev-parse', `${committed.oid}:theirs.md`)).toBe(
		await git(root, 'rev-parse', `${sides.theirs}:theirs.md`),
	);
	expect(await readText(root, 'theirs.md')).toBe('mine\n');
	expect(await readText(root, '.git/MERGE_HEAD')).toBeUndefined();
});

test('a published merge writes its index entries and stages together', async () => {
	const made = await folder();

	expect(
		expectOk(await made.history.mergeIncoming({ conflicts: 'leave' })),
	).toMatchObject({ status: 'conflicted' });

	const { root, sides } = made;
	expect(await git(root, 'ls-files', '--stage')).toBe(
		await preparedIndex(root, sides, { outside: false }),
	);
	expect(await readText(root, '.git/MERGE_MSG')).toBe(
		`Merge remote-tracking branch 'origin/main'\n\n# Incoming commit: ${sides.theirs}\n`,
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
