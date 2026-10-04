/**
 * Native Publication Tests
 *
 * What a native conditional write checks at its publication point, and what
 * the folder refuses to open or to inherit from its parent process.
 *
 * Key behaviors:
 * - A writer that lands while the bytes are staged is caught: the write is a
 *   `Conflict`, the other writer's bytes stay, and no scratch file is left
 * - A writer that lands between the final check and the rename is still
 *   overwritten. This is the documented limit, pinned so it is never claimed
 *   away: the check is best effort, not a compare-and-swap
 * - A move rechecks its source after preparing the destination
 * - A linked `.git`, a `gitdir:` file, and a linked scratch directory are
 *   refused before Git is initialized or anything is written
 * - `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` in the parent
 *   environment do not redirect the folder's Git commands
 * - A root whose `.git` disappeared never falls through to a repository in a
 *   directory above it
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs/promises';
import { join, sep } from 'node:path';
import { expectErr } from 'wellcrafted/testing';
import { defineFolder, defineTable, field } from './contract.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';
import { hashBytes } from './capture.js';

const real = { ...realFs };
const {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} = real;

/** Runs at the two publication points of a native write, when set. */
let afterStage: (() => Promise<void>) | undefined;
let beforeRename: (() => Promise<void>) | undefined;
let afterMkdir: ((path: string) => Promise<void>) | undefined;
const SCRATCH = `${sep}.git${sep}epicenter${sep}scratch${sep}`;

// The native store reads these bindings at call time, so the hooks observe
// the real staging write and the real rename without a production seam.
mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async writeFile(...args: Parameters<typeof real.writeFile>) {
		const written = await real.writeFile(...args);
		if (String(args[0]).includes(SCRATCH)) await afterStage?.();
		return written;
	},
	async rename(...args: Parameters<typeof real.rename>) {
		if (String(args[0]).includes(SCRATCH)) await beforeRename?.();
		return real.rename(...args);
	},
	async mkdir(...args: Parameters<typeof real.mkdir>) {
		const made = await real.mkdir(...args);
		await afterMkdir?.(String(args[0]));
		return made;
	},
}));

const { createNativeFileBoundary } = await import('./native-store.js');
const { openFolder, openNativeFolder } = await import(
	'./directory.test-support.js'
);

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const author = { name: 'App', email: 'app@example.test' };
const encoder = new TextEncoder();
const roots: string[] = [];
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
const REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	afterStage = undefined;
	beforeRename = undefined;
	afterMkdir = undefined;
	for (const name of REDIRECTS) delete process.env[name];
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function root(prefix: string) {
	const created = await realpath(await scratch(prefix));
	roots.push(created);
	return created;
}

async function replace(path: string, expectedText: string, text: string) {
	const bytes = encoder.encode(text);
	return {
		kind: 'replace' as const,
		path,
		bytes,
		sha256: await hashBytes(bytes),
		expectedSha256: await hashBytes(encoder.encode(expectedText)),
	};
}

async function scratchFiles(folder: string) {
	return readdir(join(folder, '.git', 'epicenter', 'scratch')).catch(() => []);
}

test('a writer that lands while the bytes are staged is a conflict', async () => {
	const folder = await root('native-stage-');
	await writeFile(join(folder, 'note.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	afterStage = () => writeFile(join(folder, 'note.md'), 'external');

	const { error: applyError } = await boundary.apply([
		await replace('note.md', 'read', 'mine'),
	]);

	expect(applyError?.name).toBe('Conflict');
	if (applyError?.name !== 'Conflict') return;
	expect(applyError.actualSha256).toEqual(
		await hashBytes(encoder.encode('external')),
	);
	expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('external');
	expect(await scratchFiles(folder)).toEqual([]);
});

test('a file removed while the bytes are staged is a conflict, not a creation', async () => {
	const folder = await root('native-stage-removed-');
	await writeFile(join(folder, 'note.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	afterStage = () => rm(join(folder, 'note.md'));

	const { error: applyError } = await boundary.apply([
		await replace('note.md', 'read', 'mine'),
	]);

	expect(applyError?.name).toBe('Conflict');
	if (applyError?.name !== 'Conflict') return;
	expect(applyError.actualSha256).toBeUndefined();
	expect(
		await stat(join(folder, 'note.md')).then(
			() => true,
			() => false,
		),
	).toBe(false);
});

test('a writer between the final check and the rename is still overwritten', async () => {
	const folder = await root('native-rename-');
	await writeFile(join(folder, 'note.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	let landed = false;
	beforeRename = async () => {
		await writeFile(join(folder, 'note.md'), 'external');
		landed = true;
	};

	const { error: applyError } = await boundary.apply([
		await replace('note.md', 'read', 'mine'),
	]);

	expect(landed).toBe(true);
	// The remaining race: the check is not an OS-wide compare-and-swap, and
	// nothing here merges. The write reports success and the other bytes are gone.
	expect(applyError).toBeNull();
	expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('mine');
});

test('an exclusive creation never replaces a file that appeared while staging', async () => {
	const folder = await root('native-create-');
	const boundary = createNativeFileBoundary(folder);
	afterStage = () => writeFile(join(folder, 'note.md'), 'external');
	const bytes = encoder.encode('mine');

	const { error: applyError } = await boundary.apply([
		{ kind: 'create', path: 'note.md', bytes, sha256: await hashBytes(bytes) },
	]);

	expect(applyError?.name).toBe('Exists');
	expect(await readFile(join(folder, 'note.md'), 'utf8')).toBe('external');
});

test('a move rechecks its source after preparing the destination', async () => {
	const folder = await root('native-move-recheck-');
	await writeFile(join(folder, 'a.md'), 'read');
	const boundary = createNativeFileBoundary(folder);
	// Creating the destination's parent is the last step before the link.
	let edited = false;
	afterMkdir = async (path) => {
		if (edited || !path.endsWith(`${sep}moved`)) return;
		edited = true;
		await writeFile(join(folder, 'a.md'), 'external');
	};

	const { error: applyError } = await boundary.apply([
		{
			kind: 'move',
			from: 'a.md',
			to: 'moved/b.md',
			expectedSha256: await hashBytes(encoder.encode('read')),
		},
	]);

	expect(edited).toBe(true);
	expect(applyError?.name).toBe('Conflict');
	expect(await readFile(join(folder, 'a.md'), 'utf8')).toBe('external');
	expect(
		await stat(join(folder, 'moved/b.md')).then(
			() => true,
			() => false,
		),
	).toBe(false);
});

test('a linked .git is refused before Git is initialized', async () => {
	const folder = await root('native-linked-git-');
	const elsewhere = await root('native-elsewhere-');
	await symlink(elsewhere, join(folder, '.git'));

	const refused = expectErr(
		await openFolder({ root: folder, definition, git: { author } }),
	);
	expect(refused.name).toBe('InvalidRoot');
	expect(refused.message).toContain('.git is a symbolic link');
	expect(await readdir(elsewhere)).toEqual([]);
});

test('a gitdir file is refused, and the other repository is untouched', async () => {
	const main = await root('native-worktree-main-');
	await git(main, 'init', '--quiet', '--initial-branch=main');
	await git(main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
	const linked = join(await root('native-worktree-'), 'linked');
	await git(main, 'worktree', 'add', '--quiet', '-b', 'side', linked);
	expect((await lstat(join(linked, '.git'))).isFile()).toBe(true);
	const before = await git(main, 'for-each-ref');

	const refused = expectErr(
		await openFolder({ root: linked, definition, git: { author } }),
	);
	expect(refused.name).toBe('InvalidRoot');
	expect(refused.message).toContain('points at another Git directory');
	expect(await git(main, 'for-each-ref')).toBe(before);
});

test('a linked scratch directory is refused', async () => {
	const folder = await root('native-linked-scratch-');
	const elsewhere = await root('native-elsewhere-');
	await git(folder, 'init', '--quiet', '--initial-branch=main');
	await mkdir(join(folder, '.git', 'epicenter'));
	await symlink(elsewhere, join(folder, '.git', 'epicenter', 'scratch'));

	const refused = expectErr(
		await openFolder({ root: folder, definition, git: { author } }),
	);
	expect(refused.name).toBe('InvalidRoot');
	expect(refused.message).toContain(
		'.git/epicenter/scratch is a symbolic link',
	);
	expect(await readdir(elsewhere)).toEqual([]);
});

test('inherited GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE do not redirect the folder', async () => {
	const folder = await root('native-env-');
	const sentinel = await root('native-env-sentinel-');
	await git(sentinel, 'init', '--quiet', '--initial-branch=main');
	await git(sentinel, 'commit', '--quiet', '--allow-empty', '-m', 'sentinel');
	const sentinelRefs = await git(sentinel, 'for-each-ref');
	const sentinelFiles = await readdir(sentinel);
	process.env.GIT_DIR = join(sentinel, '.git');
	process.env.GIT_WORK_TREE = sentinel;
	process.env.GIT_INDEX_FILE = join(sentinel, '.git', 'redirected-index');

	const opened = await openNativeFolder({
		root: folder,
		definition,
		git: { author, commitOnEdit: false },
	});
	try {
		const { error: createError } = await opened.tables.todos.create({
			stem: 'one',
			fields: { title: 'One', done: false },
		});
		expect(createError).toBeNull();
		expect((await opened.git.commit()).status).toBe('committed');
		expect((await opened.git.stage('all')).error).toBeNull();
		expect((await opened.git.paths()).data).toEqual([]);
	} finally {
		await opened.close();
	}
	for (const name of REDIRECTS) delete process.env[name];

	expect(await git(folder, 'log', '--format=%s')).toBe('Add todos/one.md');
	expect(await git(sentinel, 'for-each-ref')).toBe(sentinelRefs);
	expect(await readdir(sentinel)).toEqual(sentinelFiles);
	expect(
		await stat(join(sentinel, '.git', 'redirected-index')).then(
			() => true,
			() => false,
		),
	).toBe(false);
});

test('a root that lost its .git never resolves to a repository above it', async () => {
	const outer = await root('native-outer-');
	await git(outer, 'init', '--quiet', '--initial-branch=main');
	await git(outer, 'commit', '--quiet', '--allow-empty', '-m', 'outer');
	const outerRefs = await git(outer, 'for-each-ref');
	const folder = join(outer, 'inner');
	await mkdir(folder);
	const opened = await openNativeFolder({
		root: folder,
		definition,
		git: { author, commitOnEdit: false },
	});
	try {
		await writeFile(join(folder, 'note.md'), 'text');
		await rm(join(folder, '.git'), { recursive: true });

		expect((await opened.git.stage('all')).error?.name).toBe('Failed');
		expect((await opened.git.paths()).error?.name).toBe('Failed');
	} finally {
		await opened.close();
	}

	expect(await git(outer, 'for-each-ref')).toBe(outerRefs);
	expect(await git(outer, 'diff', '--cached', '--name-only')).toBe('');
});
