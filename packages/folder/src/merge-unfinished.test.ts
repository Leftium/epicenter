/**
 * Unfinished Merge Tests
 *
 * `mergeIncoming({ conflicts: 'leave' })` publishes a conflicted merge the
 * way Git leaves one: files with ordinary markers, unmerged index stages,
 * and `MERGE_HEAD`, `MERGE_MSG`, and `ORIG_HEAD` beside an unmoved branch.
 * A person resolves the files, stages them, and a staged commit records the
 * merge with the original local head and the pinned fetched head as parents.
 * The journey runs a browser folder over real Git smart HTTP and a Bun
 * directory over a bare remote, each through its terminal; the focused cases
 * run the real browser backend on the in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - Saving a resolution resolves nothing; a staged commit while a path is
 *   unmerged is `Unmerged`, names it, and writes nothing
 * - The merge state survives closing and reopening, before and after staging
 * - The merge commit has both original parents even when the resolved tree
 *   is the local tree, and a fetch during resolution never changes its
 *   second parent
 * - Staging always clears stages, including a resolution equal to the base
 *   and a deletion
 * - A publication that stops partway is recovered without erasing later
 *   edits to other files, and recovery never resolves a path
 * - Merge state a failed cleanup leaves after the merge commit can never
 *   become the second parent of another commit
 * - The merge commit's first parent is `ORIG_HEAD`: a branch moved to a
 *   sibling, or to a commit that merely contains the incoming one, is
 *   refused and changes nothing, and a move after that check is refused by
 *   the commit's own compare-and-swap
 * - Unmerged stages whose `MERGE_HEAD` is gone block a whole-folder commit
 * - Independent changes around a competing line merge, and only that line
 *   is marked, as `git merge-file` marks it
 * - Root `kv.json` merges by key; a conflicting key is left as raw markers
 *   that reopen as a parse error
 * - An automatic handle on the same folder that saves while the merge is
 *   published is blocked, writes no Git state, and is not retried when the
 *   merge commit clears the merge state; only a newer save checkpoints
 * - A staged commit admitted before another handle's fast-forward stopped
 *   partway finds the update pending and writes nothing, and the update is
 *   still recoverable
 *
 * See also:
 * - `merge-unfinished-native.test.ts` for faults in a Bun directory's
 *   publication and staged commit
 * - `merge.test.ts` for merges that refuse conflicts
 * - `git/opfs-incoming.test.ts` for incoming recovery in general
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as isogit from 'isomorphic-git';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	dumpStorage,
	rawBrowserFolder,
	type TestStorage,
} from './browser-storage.test-support.js';
import { openFolder as openDirectoryFolder } from './bun.js';
import { hashBytes } from './capture.js';
import { defineFolder, type Folder, field } from './contract.js';
import type { GitBackend } from './git/backend.js';
import {
	type Attempt,
	type CommitOutcome,
	createHistory,
} from './git/history.js';
import { parseIndex } from './git/index-file.js';
import { writeCommitObject, writeFilesTree } from './git/objects.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';

const author = { name: 'Merger', email: 'merger@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (value: string | Uint8Array) =>
	typeof value === 'string' ? encoder.encode(value) : value;

const MARKED = '<<<<<<< HEAD\nred\n=======\ngreen\n>>>>>>> origin/main\n';

type Tree = Record<string, string | Uint8Array>;

/**
 * A browser folder in manual history, on `storage`, whose fetched head is
 * whatever commit a test names. Opening it again on the same storage is
 * reopening the folder.
 */
async function setup({
	storage = createTestStorage(),
	commitOnEdit = false,
	overrides = () => ({}),
}: {
	storage?: TestStorage;
	commitOnEdit?: boolean;
	overrides?: (real: GitBackend) => Partial<GitBackend>;
} = {}) {
	const raw = await rawBrowserFolder({ id: 'unfinished', storage });
	let captures = 0;
	const boundary = {
		...raw.boundary,
		capture() {
			captures++;
			return raw.boundary.capture();
		},
	};
	const real = await raw.backend({
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
	});
	const backend: GitBackend = { ...real, ...overrides(real) };
	const history = createHistory({ backend, boundary, author, commitOnEdit });

	async function write(path: string, value: string | Uint8Array) {
		const bytes = bytesOf(value);
		expectOk(
			await boundary.apply([
				{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
			]),
		);
	}
	async function remove(path: string) {
		expectOk(await boundary.apply([{ kind: 'remove', path }]));
	}
	async function read(path: string) {
		return decoder.decode(expectOk(await boundary.read(path)).bytes);
	}
	async function commit() {
		const outcome = await history.commit();
		if (outcome.status !== 'committed')
			throw new Error(`Expected a commit, got ${outcome.status}`);
		return outcome.oid;
	}
	/** A commit another owner made: exactly `tree` on top of `parent`. */
	function commitOf(parent: string, tree: Tree) {
		return real.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					new Map(
						Object.entries(tree).map(([path, value]) => [path, bytesOf(value)]),
					),
				),
				parents: [parent],
				message: 'Another owner',
				author,
			}),
		);
	}
	/** Record `oid` as the fetched remote head, as a fetch would. */
	function track(oid: string) {
		return real.withObjects((access) =>
			isogit.writeRef({
				...access,
				ref: 'refs/remotes/origin/main',
				value: oid,
				force: true,
			}),
		);
	}
	function commitOfOid(oid: string) {
		return real.withObjects(
			async (access) => (await isogit.readCommit({ ...access, oid })).commit,
		);
	}
	/** Each index entry as `stage path blob`. */
	async function stages() {
		const index = await real.readIndex();
		return (parseIndex(index!) ?? [])
			.filter((entry) => entry.stage !== 0)
			.map((entry) => `${entry.stage} ${entry.path} ${entry.oid}`);
	}
	function blob(value: string) {
		return isogit
			.hashBlob({ object: encoder.encode(value) })
			.then(({ oid }) => oid);
	}
	async function diverge({
		base,
		ours,
		theirs,
	}: {
		base: Tree;
		ours: Tree;
		theirs: Tree;
	}) {
		for (const [path, value] of Object.entries(base)) await write(path, value);
		const baseOid = await commit();
		const theirsOid = await commitOf(baseOid, theirs);
		for (const path of Object.keys(base))
			if (!(path in ours)) await remove(path);
		for (const [path, value] of Object.entries(ours)) await write(path, value);
		const oursOid = await commit();
		await track(theirsOid);
		return { base: baseOid, ours: oursOid, theirs: theirsOid };
	}
	/** Every live file and private Git file other than objects, hashed. */
	async function settledDump() {
		expectOk(await history.paths());
		return raw.dump();
	}

	return {
		storage,
		raw,
		real,
		captures: () => captures,
		history,
		write,
		remove,
		read,
		commit,
		commitOf,
		track,
		commitOfOid,
		stages,
		blob,
		diverge,
		settledDump,
		close: () => history.close(),
	};
}

type Made = Awaited<ReturnType<typeof setup>>;
const opened: Made[] = [];
afterEach(async () => {
	for (const made of opened.splice(0)) await made.close();
});

async function folder(options?: Parameters<typeof setup>[0]) {
	const made = await setup(options);
	opened.push(made);
	return made;
}

/** Close `made` and open the same storage again. */
async function reopen(made: Made) {
	await made.close();
	return folder({ storage: made.storage });
}

const COLOR = {
	base: { 'notes/color.txt': 'blue\n', 'keep.md': 'keep\n' },
	ours: {
		'notes/color.txt': 'red\n',
		'keep.md': 'keep\n',
		'ours.md': 'ours\n',
	},
	theirs: {
		'notes/color.txt': 'green\n',
		'keep.md': 'keep\n',
		'theirs.md': 'theirs\n',
	},
};

describe('a conflict left in place', () => {
	test('writes markers and stages, keeps the branch, and commits only after staging, across reopening', async () => {
		let made = await folder();
		const sides = await made.diverge(COLOR);

		const left = expectOk(
			await made.history.mergeIncoming({ conflicts: 'leave' }),
		);

		expect(left).toEqual({
			status: 'conflicted',
			from: sides.ours,
			fetched: sides.theirs,
			conflicts: [{ reason: 'content', path: 'notes/color.txt' }],
			changedPaths: ['notes/color.txt', 'theirs.md'],
		});
		expect(await made.real.readBranch()).toBe(sides.ours);
		expect(await made.read('notes/color.txt')).toBe(MARKED);
		expect(await made.read('theirs.md')).toBe('theirs\n');
		expect(await made.read('ours.md')).toBe('ours\n');
		expect(await made.stages()).toEqual([
			`1 notes/color.txt ${await made.blob('blue\n')}`,
			`2 notes/color.txt ${await made.blob('red\n')}`,
			`3 notes/color.txt ${await made.blob('green\n')}`,
		]);
		expect(expectOk(await made.history.paths())).toEqual([
			{ path: 'notes/color.txt', index: 'U', worktree: 'U' },
			{ path: 'theirs.md', index: 'A', worktree: ' ' },
		]);
		expect(made.history.snapshot.merging).toEqual({
			incoming: sides.theirs,
			head: sides.ours,
			unresolved: ['notes/color.txt'],
		});
		expect(made.history.snapshot.pendingIncoming).toBeUndefined();

		// Whole-folder work and new incoming updates wait for the merge.
		expect(await made.history.commit()).toMatchObject({ status: 'blocked' });
		expect(expectErr(await made.history.pullFastForward()).name).toBe(
			'Blocked',
		);
		expect(expectErr(await made.history.mergeIncoming()).name).toBe('Blocked');

		// Saving a resolution resolves nothing.
		await made.write('notes/color.txt', 'green\n');
		const before = await made.settledDump();
		expect(expectErr(await made.history.commitStaged('Merge'))).toMatchObject({
			name: 'Unmerged',
			paths: ['notes/color.txt'],
		});
		expect(await made.raw.dump()).toEqual(before);
		expect(await made.real.readBranch()).toBe(sides.ours);

		made = await reopen(made);
		expectOk(await made.history.status());
		expect(expectOk(await made.history.paths())[0]).toEqual({
			path: 'notes/color.txt',
			index: 'U',
			worktree: 'U',
		});
		expect(made.history.snapshot.merging?.unresolved).toEqual([
			'notes/color.txt',
		]);
		expect(await made.read('notes/color.txt')).toBe('green\n');

		expectOk(await made.history.stage(['notes/color.txt']));
		expect(made.history.snapshot.merging).toEqual({
			incoming: sides.theirs,
			head: sides.ours,
			unresolved: [],
		});
		expect(await made.stages()).toEqual([]);

		made = await reopen(made);
		expect(expectOk(await made.history.status()).head).toBe(sides.ours);
		expect(made.history.snapshot.merging?.unresolved).toEqual([]);

		const committed = expectOk(await made.history.commitStaged('Merge'));
		expect(committed).toEqual({
			oid: expect.any(String),
			parent: sides.ours,
			incoming: sides.theirs,
		});
		expect((await made.commitOfOid(committed.oid)).parent).toEqual([
			sides.ours,
			sides.theirs,
		]);
		expect(await made.real.readBranch()).toBe(committed.oid);
		expect(await made.real.mergeState()).toBeUndefined();
		expect(made.history.snapshot.merging).toBeUndefined();
		expect(expectOk(await made.history.paths())).toEqual([]);
		expect(expectOk(await made.history.status()).changes).toEqual([]);
		// ORIG_HEAD stays, as Git leaves it.
		expect(await made.raw.dump()).toHaveProperty(['git:/git/ORIG_HEAD']);
	});

	test('a resolution equal to the local tree still records both parents', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: { 'notes/color.txt': 'blue\n' },
			ours: { 'notes/color.txt': 'red\n' },
			theirs: { 'notes/color.txt': 'green\n' },
		});
		expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));

		await made.write('notes/color.txt', 'red\n');
		expectOk(await made.history.stage('all'));
		const committed = expectOk(await made.history.commitStaged('Keep red'));

		const commit = await made.commitOfOid(committed.oid);
		expect(commit.parent).toEqual([sides.ours, sides.theirs]);
		expect(commit.tree).toBe((await made.commitOfOid(sides.ours)).tree);
	});

	test('a resolution equal to the base bytes still clears every stage', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: { 'notes/color.txt': 'blue\n' },
			ours: { 'notes/color.txt': 'red\n' },
			theirs: { 'notes/color.txt': 'green\n' },
		});
		expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));

		await made.write('notes/color.txt', 'blue\n');
		// Reading status compares the file with its base stage and resolves
		// nothing.
		expect(expectOk(await made.history.paths())).toEqual([
			{ path: 'notes/color.txt', index: 'U', worktree: 'U' },
		]);
		expectOk(await made.history.status());
		expect((await made.stages()).length).toBe(3);
		expect(made.history.snapshot.merging?.unresolved).toEqual([
			'notes/color.txt',
		]);

		expectOk(await made.history.stage(['notes/color.txt']));

		expect(await made.stages()).toEqual([]);
		expect(made.history.snapshot.merging?.unresolved).toEqual([]);
		expect(expectOk(await made.history.paths())).toEqual([
			{ path: 'notes/color.txt', index: 'M', worktree: ' ' },
		]);
		const committed = expectOk(await made.history.commitStaged('Back to blue'));
		expect((await made.commitOfOid(committed.oid)).parent).toEqual([
			sides.ours,
			sides.theirs,
		]);
	});

	test('a deletion against a change is left as the changed file and resolved by staging its removal', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: { 'gone.md': 'kept\n', 'keep.md': 'keep\n' },
			ours: { 'keep.md': 'keep\n' },
			theirs: { 'gone.md': 'changed\n', 'keep.md': 'keep\n' },
		});

		const left = expectOk(
			await made.history.mergeIncoming({ conflicts: 'leave' }),
		);

		expect(left).toMatchObject({
			status: 'conflicted',
			conflicts: [{ reason: 'deleted', path: 'gone.md', deletedBy: 'ours' }],
		});
		expect(await made.read('gone.md')).toBe('changed\n');
		expect(expectOk(await made.history.paths())).toEqual([
			{ path: 'gone.md', index: 'D', worktree: 'U' },
		]);
		await made.remove('gone.md');
		expectOk(await made.history.stage(['gone.md']));
		expect(await made.stages()).toEqual([]);
		const committed = expectOk(await made.history.commitStaged('Delete it'));
		const commit = await made.commitOfOid(committed.oid);
		expect(commit.parent).toEqual([sides.ours, sides.theirs]);
		expect(commit.tree).toBe((await made.commitOfOid(sides.ours)).tree);
	});

	test('a fetch during resolution moves the tracking ref but not the incoming parent', async () => {
		const made = await folder();
		const sides = await made.diverge(COLOR);
		expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));

		const newer = await made.commitOf(sides.theirs, {
			...COLOR.theirs,
			'later.md': 'later\n',
		});
		await made.track(newer);
		expect(await made.real.readRemoteTracking()).toBe(newer);

		await made.write('notes/color.txt', 'purple\n');
		expectOk(await made.history.stage('all'));
		const committed = expectOk(await made.history.commitStaged('Purple'));
		expect((await made.commitOfOid(committed.oid)).parent).toEqual([
			sides.ours,
			sides.theirs,
		]);
		expect(made.history.snapshot.sync).toMatchObject({
			state: 'observed',
			value: { head: committed.oid, remote: newer, behind: 1 },
		});
	});

	test('binary bytes keep ours while every side becomes a stage', async () => {
		const made = await folder();
		const [b, o, t] = [
			[0xff, 0, 1],
			[0xff, 0, 2],
			[0xff, 0, 3],
		].map((bytes) => Uint8Array.from(bytes));
		await made.diverge({
			base: { 'take.bin': b! },
			ours: { 'take.bin': o! },
			theirs: { 'take.bin': t! },
		});

		const left = expectOk(
			await made.history.mergeIncoming({ conflicts: 'leave' }),
		);

		expect(left).toMatchObject({
			status: 'conflicted',
			conflicts: [{ reason: 'binary', path: 'take.bin' }],
			// Ours is already in the folder: no file is written.
			changedPaths: [],
		});
		expect(expectOk(await made.raw.boundary.read('take.bin')).bytes).toEqual(
			o!,
		);
		expect((await made.stages()).map((entry) => entry.slice(0, 10))).toEqual([
			'1 take.bin',
			'2 take.bin',
			'3 take.bin',
		]);
	});

	test('both sides adding different bytes stays unmerged through status reads', async () => {
		// The folder holds ours, which is the first stage the index lists:
		// a status walk that refreshed the index would resolve it.
		const made = await folder();
		await made.diverge({
			base: { 'keep.md': 'keep\n' },
			ours: { 'keep.md': 'keep\n', 'take.bin': Uint8Array.from([0, 1]) },
			theirs: { 'keep.md': 'keep\n', 'take.bin': Uint8Array.from([0, 2]) },
		});

		expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));
		for (let look = 0; look < 2; look++) {
			expect(expectOk(await made.history.paths())).toEqual([
				{ path: 'take.bin', index: 'A', worktree: 'A' },
			]);
			expectOk(await made.history.status());
			expectOk(await made.history.diff({ staged: false, paths: [] }));
		}

		expect((await made.stages()).map((entry) => entry.slice(0, 10))).toEqual([
			'2 take.bin',
			'3 take.bin',
		]);
		expect(expectErr(await made.history.commitStaged('Too soon')).name).toBe(
			'Unmerged',
		);
	});
});

describe('what leaving refuses', () => {
	test('automatic history refuses before anything is read or written', async () => {
		const made = await folder({ commitOnEdit: true });
		await made.diverge(COLOR);
		const before = await made.settledDump();
		const lastMerge = made.history.snapshot.lastMerge;

		expect(
			expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })).name,
		).toBe('AutomaticHistory');

		expect(await made.raw.dump()).toEqual(before);
		expect(made.history.snapshot.lastMerge).toBe(lastMerge);
	});

	test('a file against a directory is still refused and writes nothing', async () => {
		const made = await folder();
		const sides = await made.diverge({
			base: { 'keep.md': 'keep\n' },
			ours: { 'keep.md': 'keep\n', notes: 'a file\n' },
			theirs: { 'keep.md': 'keep\n', 'notes/inside.md': 'inside\n' },
		});
		const before = await made.settledDump();

		const refused = expectErr(
			await made.history.mergeIncoming({ conflicts: 'leave' }),
		);

		expect(refused).toMatchObject({
			name: 'Conflicted',
			conflicts: [{ reason: 'shape', path: 'notes' }],
		});
		expect(await made.raw.dump()).toEqual(before);
		expect(await made.real.readBranch()).toBe(sides.ours);
		expect(await made.real.mergeState()).toBeUndefined();
	});

	test('the default still refuses the same conflict and writes nothing', async () => {
		const made = await folder();
		const sides = await made.diverge(COLOR);
		const before = await made.settledDump();

		expect(expectErr(await made.history.mergeIncoming())).toMatchObject({
			name: 'Conflicted',
			conflicts: [{ reason: 'content', path: 'notes/color.txt' }],
		});
		expect(await made.raw.dump()).toEqual(before);
		expect(await made.real.readBranch()).toBe(sides.ours);
	});
});

describe('publication that stops partway', () => {
	/** A merge whose second written file fails, leaving the record pending. */
	async function interrupted() {
		const storage = createTestStorage();
		let fail = true;
		storage.opfs.faults.write = (path) => {
			if (fail && path.endsWith('/z.md')) {
				fail = false;
				return 'fail';
			}
			return undefined;
		};
		const made = await folder({ storage });
		const sides = await made.diverge({
			base: { 'notes/color.txt': 'blue\n', 'other.md': 'other\n' },
			ours: { 'notes/color.txt': 'red\n', 'other.md': 'other\n' },
			theirs: {
				'notes/color.txt': 'green\n',
				'other.md': 'other\n',
				'z.md': 'last\n',
			},
		});
		const stopped = expectErr(
			await made.history.mergeIncoming({ conflicts: 'leave' }),
		);
		expect(stopped).toMatchObject({
			name: 'Partial',
			applied: [{ kind: 'write', path: 'notes/color.txt' }],
		});
		expect(made.history.snapshot.pendingIncoming).toMatchObject({
			state: 'recorded',
			expectedHead: sides.ours,
			merge: { incoming: sides.theirs },
		});
		// Its merge state is not written yet, and staging waits for recovery.
		expect(await made.real.mergeState()).toBeUndefined();
		expect(expectErr(await made.history.stage('all')).name).toBe(
			'IncomingPending',
		);
		return { made, sides };
	}

	test('recovery finishes the publication and keeps a later edit to another file', async () => {
		const { made, sides } = await interrupted();
		await made.write('other.md', 'edited meanwhile\n');

		expect(expectOk(await made.history.recoverIncoming())).toMatchObject({
			status: 'completed',
			changedPaths: ['notes/color.txt', 'z.md'],
		});

		expect(await made.read('other.md')).toBe('edited meanwhile\n');
		expect(await made.read('notes/color.txt')).toBe(MARKED);
		expect(await made.read('z.md')).toBe('last\n');
		expect(await made.real.readBranch()).toBe(sides.ours);
		expect(made.history.snapshot.pendingIncoming).toBeUndefined();
		expect(made.history.snapshot.merging).toEqual({
			incoming: sides.theirs,
			head: sides.ours,
			unresolved: ['notes/color.txt'],
		});
		expect((await made.stages()).length).toBe(3);
		expect(expectOk(await made.history.paths())).toEqual([
			{ path: 'notes/color.txt', index: 'U', worktree: 'U' },
			{ path: 'other.md', index: ' ', worktree: 'M' },
			{ path: 'z.md', index: 'A', worktree: ' ' },
		]);
		// Recovering again finds nothing pending and resolves nothing.
		expect(expectOk(await made.history.recoverIncoming())).toEqual({
			status: 'none',
		});
		expect(made.history.snapshot.merging?.unresolved).toEqual([
			'notes/color.txt',
		]);
	});

	test('recovery refuses a marker file someone edited since, and names it', async () => {
		const { made } = await interrupted();
		await made.write('notes/color.txt', 'my resolution\n');

		expect(expectErr(await made.history.recoverIncoming())).toMatchObject({
			name: 'RecoveryRefused',
			paths: ['notes/color.txt'],
		});
		expect(await made.read('notes/color.txt')).toBe('my resolution\n');
		expect(made.history.snapshot.pendingIncoming?.state).toBe('recorded');
	});

	test('completed publication clears its leftover record without replaying a later resolution', async () => {
		const storage = createTestStorage();
		const made = await folder({ storage });
		const sides = await made.diverge(COLOR);
		let fail = true;
		storage.opfs.faults.remove = (path) => {
			if (fail && path.endsWith('/.git/epicenter-incoming.json')) {
				fail = false;
				return 'fail';
			}
			return undefined;
		};
		expect(
			expectOk(await made.history.mergeIncoming({ conflicts: 'leave' })).status,
		).toBe('conflicted');
		expect(made.history.snapshot.pendingIncoming?.state).toBe('recorded');
		expect(await made.real.mergeState()).toMatchObject({
			incoming: sides.theirs,
		});
		await made.write('notes/color.txt', 'my later resolution\n');
		const index = await made.real.readIndex();
		await made.close();
		const reopened = await folder({ storage });
		expect(expectOk(await reopened.history.recoverIncoming()).status).toBe(
			'cleared',
		);
		expect(await reopened.read('notes/color.txt')).toBe(
			'my later resolution\n',
		);
		expect(await reopened.real.readIndex()).toEqual(index);
		expect(await reopened.real.readBranch()).toBe(sides.ours);
		expect(reopened.history.snapshot.pendingIncoming).toBeUndefined();
		expect(reopened.history.snapshot.merging?.unresolved).toEqual([
			'notes/color.txt',
		]);
	});

	test('recovery finishes a publication whose merge state was the step that failed', async () => {
		const storage = createTestStorage();
		let fail = true;
		storage.opfs.faults.write = (path) => {
			if (fail && path.endsWith('/.git/MERGE_HEAD')) {
				fail = false;
				return 'fail';
			}
			return undefined;
		};
		const made = await folder({ storage });
		const sides = await made.diverge(COLOR);

		expect(
			expectErr(await made.history.mergeIncoming({ conflicts: 'leave' })).name,
		).toBe('Partial');
		expect(await made.real.mergeState()).toBeUndefined();
		expect((await made.stages()).length).toBe(3);

		expect(expectOk(await made.history.recoverIncoming()).status).toBe(
			'completed',
		);
		expect(await made.real.mergeState()).toEqual({
			incoming: sides.theirs,
			head: sides.ours,
			unresolved: ['notes/color.txt'],
		});
		expect(await made.real.readBranch()).toBe(sides.ours);
	});
});

describe('the merge commit keeps the head the merge began from', () => {
	/** A merge left in place, resolved and staged, and a sibling of its head. */
	async function staged(options?: Parameters<typeof setup>[0]) {
		const made = await folder(options);
		const sides = await made.diverge(COLOR);
		expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));
		await made.write('notes/color.txt', 'green\n');
		expectOk(await made.history.stage('all'));
		const sibling = await made.commitOf(sides.base, {
			...COLOR.base,
			'sibling.md': 'another owner\n',
		});
		return { made, sides, sibling };
	}

	test('a branch moved to a sibling refuses the merge commit and changes nothing', async () => {
		const { made, sides, sibling } = await staged();
		expect(await made.real.casBranch(sides.ours, sibling)).toEqual({
			ok: true,
		});
		const before = await made.settledDump();

		expect(expectErr(await made.history.commitStaged('Merge'))).toMatchObject({
			name: 'BranchMoved',
			expected: sides.ours,
			actual: sibling,
		});

		expect(await made.raw.dump()).toEqual(before);
		expect(await made.real.mergeState()).toEqual({
			incoming: sides.theirs,
			head: sides.ours,
			unresolved: [],
		});

		// Moving the branch back finishes the merge with its original parents.
		expect(await made.real.casBranch(sibling, sides.ours)).toEqual({
			ok: true,
		});
		const committed = expectOk(await made.history.commitStaged('Merge'));
		expect((await made.commitOfOid(committed.oid)).parent).toEqual([
			sides.ours,
			sides.theirs,
		]);
	});

	test('a branch that contains the incoming commit is not taken for the merge commit', async () => {
		const { made, sides } = await staged();
		expect(await made.real.casBranch(sides.ours, sides.theirs)).toEqual({
			ok: true,
		});
		const before = await made.settledDump();

		expect(expectErr(await made.history.commitStaged('Merge'))).toMatchObject({
			name: 'BranchMoved',
			expected: sides.ours,
			actual: sides.theirs,
		});

		expect(await made.raw.dump()).toEqual(before);
		expect(await made.real.readBranch()).toBe(sides.theirs);
		expect(made.history.snapshot.merging?.incoming).toBe(sides.theirs);
	});

	test('a branch moved after the check is refused by the commit itself', async () => {
		let move: (() => Promise<unknown>) | undefined;
		const { made, sides, sibling } = await staged({
			overrides: (real) => ({
				async commitIndex(...args) {
					await move?.();
					return real.commitIndex(...args);
				},
			}),
		});
		move = () => made.real.casBranch(sides.ours, sibling);

		expect(expectErr(await made.history.commitStaged('Merge'))).toMatchObject({
			name: 'BranchMoved',
			expected: sides.ours,
			actual: sibling,
		});

		expect(await made.real.readBranch()).toBe(sibling);
		expect(await made.real.mergeState()).toEqual({
			incoming: sides.theirs,
			head: sides.ours,
			unresolved: [],
		});
		expect(await made.stages()).toEqual([]);
	});
});

test('a whole-folder commit refuses unmerged stages whose MERGE_HEAD is gone', async () => {
	const made = await folder();
	const sides = await made.diverge(COLOR);
	expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));
	// Damaged merge state: the stages remain, and nothing names the merge.
	await made.real.clearMerge();
	expect(await made.real.mergeState()).toBeUndefined();

	const outcome = await made.history.commit();

	expect(outcome).toMatchObject({ status: 'blocked' });
	expect(outcome.status === 'blocked' && outcome.reason).toContain(
		'notes/color.txt has unmerged index stages',
	);
	expect(await made.real.readBranch()).toBe(sides.ours);
	expect((await made.stages()).length).toBe(3);
	expect(await made.read('notes/color.txt')).toBe(MARKED);
});

test('independent changes around a competing line merge, and only that line is marked', async () => {
	const made = await folder();
	const lines = (...values: string[]) => values.map((v) => `${v}\n`).join('');
	const base = lines('title', 'alpha', 'beta', 'color: blue', 'gamma', 'delta');
	const ours = lines('title', 'ALPHA', 'beta', 'color: red', 'gamma', 'delta');
	const theirs = lines(
		'title',
		'alpha',
		'beta',
		'color: green',
		'gamma',
		'delta',
		'epsilon',
	);
	await made.diverge({
		base: { 'notes.md': base },
		ours: { 'notes.md': ours },
		theirs: { 'notes.md': theirs },
	});

	expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));

	const marked = lines(
		'title',
		'ALPHA',
		'beta',
		'<<<<<<< HEAD',
		'color: red',
		'=======',
		'color: green',
		'>>>>>>> origin/main',
		'gamma',
		'delta',
		'epsilon',
	);
	expect(await made.read('notes.md')).toBe(marked);
	// Git's own line merge of the same three versions agrees.
	const root = await scratch('unfinished-merge-file-');
	try {
		for (const [name, text] of Object.entries({ base, ours, theirs }))
			await writeFile(join(root, name), text);
		const merged = Bun.spawnSync(
			[
				'git',
				'merge-file',
				'-p',
				'-L',
				'HEAD',
				'-L',
				'base',
				'-L',
				'origin/main',
				'ours',
				'base',
				'theirs',
			],
			{ cwd: root, env: GIT_ENV },
		);
		expect(decoder.decode(merged.stdout)).toBe(marked);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('merge state a failed cleanup leaves behind never becomes a second parent again', async () => {
	let failCleanup = true;
	const made = await folder({
		overrides: (real) => ({
			async clearMerge() {
				if (failCleanup) {
					failCleanup = false;
					throw new Error('Injected cleanup failure');
				}
				return real.clearMerge();
			},
		}),
	});
	const sides = await made.diverge(COLOR);
	expectOk(await made.history.mergeIncoming({ conflicts: 'leave' }));
	await made.write('notes/color.txt', 'green\n');
	expectOk(await made.history.stage('all'));

	const committed = expectOk(await made.history.commitStaged('Merge'));

	expect(committed).toMatchObject({
		incoming: sides.theirs,
		mergeStateWarning: 'Injected cleanup failure',
	});
	expect(await made.real.readBranch()).toBe(committed.oid);
	// Still visible, and still blocking whole-folder work.
	expect(made.history.snapshot.merging?.incoming).toBe(sides.theirs);
	expect(await made.history.commit()).toMatchObject({ status: 'blocked' });

	// The next staged commit sees the branch already holds the incoming
	// commit, removes the stale state, and makes no second merge.
	expect(expectErr(await made.history.commitStaged('Again')).name).toBe(
		'NothingToCommit',
	);
	expect(await made.real.readBranch()).toBe(committed.oid);
	expect(await made.real.mergeState()).toBeUndefined();
	expect(made.history.snapshot.merging).toBeUndefined();
	const [head] = expectOk(await made.history.log(1));
	expect(head?.parents).toEqual([sides.ours, sides.theirs]);
});

describe('owners sharing one folder', () => {
	/** A promise the test resolves when it chooses. */
	function gate() {
		const { promise, resolve } = Promise.withResolvers<void>();
		return { opened: promise, open: () => resolve() };
	}

	/** A save `made` published, notified as the folder's storage notifies it. */
	async function save(made: Made, path: string, value: string) {
		await made.write(path, value);
		made.history.noteEdit();
		made.history.requestAutomaticCommit();
	}

	/**
	 * The next commit attempt `made` records, once its automatic worker has
	 * retired. Ask before the attempt can settle.
	 */
	function nextAttempt(made: Made) {
		const before = made.history.snapshot.lastCommit;
		return new Promise<Attempt<CommitOutcome>>((resolve) => {
			const stop = made.history.subscribe((snapshot) => {
				const attempt = snapshot.lastCommit;
				if (
					attempt === undefined ||
					attempt === before ||
					snapshot.activity.commit.active
				)
					return;
				stop();
				resolve(attempt);
			});
		});
	}

	/** Every private Git file, including unreachable objects. */
	async function gitState(made: Made) {
		return Object.fromEntries(
			Object.entries(
				await dumpStorage(made.storage, 'unfinished', () => false),
			).filter(([key]) => key.startsWith('git:')),
		);
	}

	test('an automatic save that waited behind a left conflict is blocked, and only a newer save checkpoints after the merge commit', async () => {
		// The manual handle's next exclusive work stays inside the protection
		// after it returns, until `release` opens.
		let hold: ReturnType<typeof gate> | undefined;
		const published = gate();
		let manual = await folder({
			overrides: (real) => ({
				exclusive: (work, signal) =>
					real.exclusive(async () => {
						const value = await work();
						const held = hold;
						hold = undefined;
						if (held !== undefined) {
							published.open();
							await held.opened;
						}
						return value;
					}, signal),
			}),
		});
		const automatic = await folder({
			storage: manual.storage,
			commitOnEdit: true,
		});
		const sides = await manual.diverge(COLOR);
		const captures = automatic.captures();

		const release = gate();
		try {
			hold = release;
			const leaving = manual.history.mergeIncoming({ conflicts: 'leave' });
			await published.opened;
			expect(await manual.real.mergeState()).toEqual({
				incoming: sides.theirs,
				head: sides.ours,
				unresolved: ['notes/color.txt'],
			});

			// The peer's save lands while the merge still holds the protection, and
			// its automatic commit waits for it.
			const blockedAttempt = nextAttempt(automatic);
			await save(automatic, 'other.md', 'other\n');
			expect(await automatic.read('other.md')).toBe('other\n');
			expect(automatic.history.snapshot.activity.commit.active).toBe(true);
			const stages = await manual.stages();
			expect(stages.length).toBe(3);
			const git = await gitState(manual);

			release.open();
			expect(expectOk(await leaving).status).toBe('conflicted');
			const blocked = await blockedAttempt;

			expect(blocked).toEqual({
				status: 'blocked',
				reason: expect.stringContaining(
					`a merge of ${sides.theirs} is in progress`,
				),
				at: expect.any(Number),
			});
			expect(automatic.captures()).toBe(captures);
			expect(await gitState(manual)).toEqual(git);
			expect(await manual.real.readBranch()).toBe(sides.ours);
			expect(await manual.stages()).toEqual(stages);
			expect(await manual.real.mergeState()).toEqual({
				incoming: sides.theirs,
				head: sides.ours,
				unresolved: ['notes/color.txt'],
			});

			// An explicit commit from the peer is blocked the same way.
			expect(await automatic.history.commit()).toMatchObject({
				status: 'blocked',
			});
			expect(automatic.captures()).toBe(captures);
			expect(await gitState(manual)).toEqual(git);
			const answered = automatic.history.snapshot.lastCommit;

			await manual.write('notes/color.txt', 'green\n');
			expectOk(await manual.history.stage(['notes/color.txt']));
			const merged = expectOk(await manual.history.commitStaged('Merge'));
			expect((await manual.commitOfOid(merged.oid)).parent).toEqual([
				sides.ours,
				sides.theirs,
			]);
			expect(await manual.real.mergeState()).toBeUndefined();

			// Clearing the merge state asks the peer for nothing: its blocked
			// requests stay answered, and its save stays uncommitted.
			expect(expectOk(await automatic.history.paths())).toContainEqual(
				expect.objectContaining({ path: 'other.md' }),
			);
			expect(automatic.history.snapshot.activity.commit.active).toBe(false);
			expect(automatic.history.snapshot.lastCommit).toBe(answered);
			expect(await automatic.real.readBranch()).toBe(merged.oid);

			const checkpointed = nextAttempt(automatic);
			await save(automatic, 'later.md', 'later\n');
			const checkpoint = await checkpointed;
			expect(checkpoint).toMatchObject({
				status: 'committed',
				parent: merged.oid,
				changedPaths: 2,
			});
			if (checkpoint.status !== 'committed') throw new Error(checkpoint.status);

			manual = await reopen(manual);
			expect(expectOk(await manual.history.status())).toEqual({
				head: checkpoint.oid,
				changes: [],
			});
			expect(manual.history.snapshot.merging).toBeUndefined();
			expect(manual.history.snapshot.pendingIncoming).toBeUndefined();
			expect(await manual.stages()).toEqual([]);
			expect(await manual.read('notes/color.txt')).toBe('green\n');
			const [head, merge] = expectOk(await manual.history.log(2));
			expect(head?.parents).toEqual([merged.oid]);
			expect(merge).toMatchObject({
				oid: merged.oid,
				parents: [sides.ours, sides.theirs],
			});
		} finally {
			release.open();
		}
	});

	test('a staged commit admitted before a peer fast-forward stopped partway returns IncomingPending and writes nothing', async () => {
		const storage = createTestStorage();
		let failBranch = false;
		storage.opfs.faults.write = (path) => {
			if (failBranch && path.endsWith('/.git/refs/heads/main')) {
				failBranch = false;
				return 'fail';
			}
			return undefined;
		};
		// The staged handle's next exclusive request passes its checks before
		// the protection, then waits here until `enter` opens.
		let entry: ReturnType<typeof gate> | undefined;
		const admitted = gate();
		const staged = await folder({
			storage,
			overrides: (real) => ({
				exclusive: async (work, signal) => {
					const waiting = entry;
					entry = undefined;
					if (waiting !== undefined) {
						admitted.open();
						await waiting.opened;
					}
					return real.exclusive(work, signal);
				},
			}),
		});
		const peer = await folder({ storage });
		await staged.write('a.md', 'a\n');
		const base = await staged.commit();
		const next = await staged.commitOf(base, { 'a.md': 'a\n', 'b.md': 'b\n' });
		await staged.track(next);

		const enter = gate();
		try {
			entry = enter;
			const committing = staged.history.commitStaged('Staged');
			await admitted.opened;

			// The peer's fast-forward writes the file and the index, then fails to
			// move the branch: its record stays, over the old head.
			failBranch = true;
			expect(expectErr(await peer.history.pullFastForward()).name).toBe(
				'Partial',
			);
			const pending = peer.history.snapshot.pendingIncoming;
			expect(pending).toMatchObject({
				state: 'recorded',
				expectedHead: base,
				nextHead: next,
			});
			expect(await staged.read('b.md')).toBe('b\n');
			expect(await staged.real.readBranch()).toBe(base);
			const stopped = await staged.raw.dump();

			enter.open();
			const refused = await committing;

			expect(await staged.raw.dump()).toEqual(stopped);
			expect(await staged.real.readBranch()).toBe(base);
			expect(expectErr(refused)).toMatchObject({
				name: 'IncomingPending',
				pending,
			});

			expect(expectOk(await peer.history.recoverIncoming())).toMatchObject({
				status: 'completed',
				changedPaths: ['b.md'],
			});
			expect(await peer.real.readBranch()).toBe(next);
			expect(peer.history.snapshot.pendingIncoming).toBeUndefined();
			expect(expectOk(await peer.history.status())).toEqual({
				head: next,
				changes: [],
			});
		} finally {
			enter.open();
		}
	});
});

describe('root kv.json', () => {
	test('different keys merge by key while another path is left conflicted', async () => {
		const made = await folder();
		await made.diverge({
			base: { 'kv.json': '{"theme":"light","lang":"en"}', ...COLOR.base },
			ours: { 'kv.json': '{"theme":"dark","lang":"en"}', ...COLOR.ours },
			theirs: { 'kv.json': '{"theme":"light","lang":"zh"}', ...COLOR.theirs },
		});

		const left = expectOk(
			await made.history.mergeIncoming({ conflicts: 'leave' }),
		);

		expect(left).toMatchObject({
			status: 'conflicted',
			conflicts: [{ reason: 'content', path: 'notes/color.txt' }],
		});
		expect(await made.read('kv.json')).toBe(
			'{\n  "lang": "zh",\n  "theme": "dark"\n}\n',
		);
		expect(made.history.snapshot.merging?.unresolved).toEqual([
			'notes/color.txt',
		]);
	});
});

describe('the journey', () => {
	const definition = defineFolder({
		kv: { theme: field.string() },
		tables: {},
	});
	const originalFetch = globalThis.fetch;
	const originalEnv = { ...process.env };
	beforeAll(() => {
		Object.assign(process.env, {
			GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
			GIT_CONFIG_NOSYSTEM: '1',
		});
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
	});
	const roots: string[] = [];
	afterEach(async () => {
		for (const root of roots.splice(0))
			await rm(root, { recursive: true, force: true });
	});

	/** A folder of `kind` whose remote is `bare`, and how to open it again. */
	async function place(kind: 'browser' | 'directory', root: string) {
		const bare = await createBareRemote(root);
		if (kind === 'browser') {
			globalThis.fetch = await gitHttpFetch(root);
			const environment = createTestStorage();
			const open = async (): Promise<Folder<typeof definition>> =>
				expectOk(
					await openBrowserFolder({
						id: 'so.epicenter.unfinished',
						definition,
						browser: {
							author,
							commitOnEdit: false,
							remote: { url: 'http://git.test/remote.git', branch: 'main' },
							...browserStorage(environment),
						},
					}),
				);
			return { bare, open, directory: undefined };
		}
		const directory = join(root, 'local');
		await mkdir(directory);
		const open = async (): Promise<Folder<typeof definition>> =>
			expectOk(
				await openDirectoryFolder({
					root: directory,
					definition,
					git: {
						author,
						commitOnEdit: false,
						remote: { url: bare, branch: 'main' },
					},
				}),
			);
		return { bare, open, directory };
	}

	for (const kind of ['browser', 'directory'] as const)
		test(`${kind}: a clean divergence keeps both histories, and red against green is resolved in the terminal`, async () => {
			const root = await scratch(`unfinished-${kind}-`);
			roots.push(root);
			const { bare, open, directory } = await place(kind, root);
			let folder = await open();
			try {
				expectOk(await folder.files.create('notes/color.txt', 'blue\n'));
				expectOk(await folder.files.create('a.md', 'a\n'));
				expect((await folder.git.commitAndPush()).push.status).toBe('pushed');

				// Another copy changes a different file and pushes.
				const upstream = join(root, 'upstream');
				await git(root, 'clone', '--quiet', bare, upstream);
				await writeFile(join(upstream, 'b.md'), 'b\n');
				await git(upstream, 'add', 'b.md');
				await git(upstream, 'commit', '--quiet', '-m', 'Add b');
				await git(upstream, 'push', '--quiet', 'origin', 'main');
				const cleanRemote = await git(bare, 'rev-parse', 'main');

				expectOk(await folder.files.overwrite('a.md', 'a, locally\n'));
				const local = await folder.git.commit();
				if (local.status !== 'committed') throw new Error(local.status);
				expectOk(await folder.git.fetch());
				const clean = expectOk(
					await folder.git.mergeIncoming({ conflicts: 'leave' }),
				);
				if (clean.status !== 'merged') throw new Error(clean.status);
				expect(expectOk(await folder.git.log(1))[0]?.parents).toEqual([
					local.oid,
					cleanRemote,
				]);
				expect((await folder.git.push()).status).toBe('pushed');

				// Now red here against green there.
				await git(upstream, 'pull', '--quiet', '--ff-only');
				await writeFile(join(upstream, 'notes/color.txt'), 'green\n');
				await git(upstream, 'commit', '--quiet', '-am', 'Green');
				await git(upstream, 'push', '--quiet', 'origin', 'main');
				const green = await git(bare, 'rev-parse', 'main');
				expectOk(await folder.files.overwrite('notes/color.txt', 'red\n'));
				const red = await folder.git.commit();
				if (red.status !== 'committed') throw new Error(red.status);
				expectOk(await folder.git.fetch());

				const terminal = folder.terminal();
				const merged = await terminal.exec('git merge; cat notes/color.txt');
				expect(merged.stdout).toBe(
					`CONFLICT (content): Merge conflict in notes/color.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n${MARKED}`,
				);
				expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(red.oid);
				const status = await terminal.exec('git status');
				expect(status.stdout).toContain('You have unmerged paths.');
				expect(status.stdout).toContain('UU notes/color.txt');
				if (directory !== undefined) {
					expect(await git(directory, 'status', '--porcelain')).toBe(
						'UU notes/color.txt',
					);
					expect(
						(await readFile(join(directory, '.git/MERGE_HEAD'), 'utf8')).trim(),
					).toBe(green);
				}

				await folder.close();
				folder = await open();
				expect((await folder.git.status()).error).toBeNull();
				expect(folder.git.snapshot.merging).toEqual({
					incoming: green,
					head: red.oid,
					unresolved: ['notes/color.txt'],
				});

				const shell = folder.terminal();
				expect(
					(await shell.exec("printf 'green\\n' > notes/color.txt")).exitCode,
				).toBe(0);
				const refused = await shell.exec('git commit -m "Merge green"');
				expect(refused.exitCode).toBe(128);
				expect(refused.stderr).toContain('U\tnotes/color.txt');
				expect(
					decoder.decode(
						expectOk(await folder.files.read('notes/color.txt')).bytes,
					),
				).toBe('green\n');

				// The remote moves on while the merge waits; the merge does not.
				await writeFile(join(upstream, 'c.md'), 'c\n');
				await git(upstream, 'add', 'c.md');
				await git(upstream, 'commit', '--quiet', '-m', 'Add c');
				await git(upstream, 'push', '--quiet', 'origin', 'main');
				expect((await shell.exec('git fetch')).exitCode).toBe(0);
				expect(folder.git.snapshot.merging?.incoming).toBe(green);

				expect((await shell.exec('git add notes/color.txt')).exitCode).toBe(0);
				await folder.close();
				folder = await open();
				expect((await folder.git.status()).error).toBeNull();
				expect(folder.git.snapshot.merging?.unresolved).toEqual([]);

				const finished = await folder
					.terminal()
					.exec('git commit -m "Merge green"');
				expect(finished).toMatchObject({ exitCode: 0, stderr: '' });
				const [head] = expectOk(await folder.git.log(1));
				expect(head?.parents).toEqual([red.oid, green]);
				expect(folder.git.snapshot.merging).toBeUndefined();
				if (directory !== undefined) {
					expect(await git(directory, 'log', '-1', '--format=%P')).toBe(
						`${red.oid} ${green}`,
					);
					expect(await git(directory, 'status', '--porcelain')).toBe('');
					expect(
						await stat(join(directory, '.git/MERGE_HEAD')).then(
							() => true,
							() => false,
						),
					).toBe(false);
				}
			} finally {
				await folder.close();
			}
		});

	test('a conflicting root key is left as raw markers that reopen as a parse error', async () => {
		const root = await scratch('unfinished-kv-');
		roots.push(root);
		const { bare, open } = await place('browser', root);
		let folder = await open();
		try {
			expectOk(await folder.kv.create({ theme: 'light' }));
			expect((await folder.git.commitAndPush()).push.status).toBe('pushed');
			const upstream = join(root, 'upstream');
			await git(root, 'clone', '--quiet', bare, upstream);
			await writeFile(join(upstream, 'kv.json'), '{\n  "theme": "blue"\n}\n');
			await git(upstream, 'commit', '--quiet', '-am', 'Blue');
			await git(upstream, 'push', '--quiet', 'origin', 'main');
			expectOk(await folder.kv.update({ theme: 'dark' }));
			const local = await folder.git.commit();
			if (local.status !== 'committed') throw new Error(local.status);
			expectOk(await folder.git.fetch());

			const left = expectOk(
				await folder.git.mergeIncoming({ conflicts: 'leave' }),
			);
			expect(left).toMatchObject({
				status: 'conflicted',
				conflicts: [{ reason: 'kvKey', path: 'kv.json', key: 'theme' }],
			});
			const marked = decoder.decode(
				expectOk(await folder.files.read('kv.json')).bytes,
			);
			expect(marked).toContain('<<<<<<< HEAD\n');
			expect(marked).toContain('>>>>>>> origin/main\n');

			await folder.close();
			folder = await open();
			expect(expectOk(await folder.kv.get())?.parseError).toBeDefined();
			expect(folder.git.snapshot.merging?.unresolved).toEqual(['kv.json']);

			expectOk(
				await folder.files.overwrite('kv.json', '{\n  "theme": "blue"\n}\n'),
			);
			expectOk(await folder.git.stage(['kv.json']));
			const committed = expectOk(await folder.git.commitStaged('Take blue'));
			const blue = await git(bare, 'rev-parse', 'main');
			expect(committed.incoming).toBe(blue);
			expect(expectOk(await folder.git.log(1))[0]?.parents).toEqual([
				local.oid,
				blue,
			]);
			expect(expectOk(await folder.kv.get())?.values).toEqual({
				theme: 'blue',
			});
		} finally {
			await folder.close();
		}
	});
});
