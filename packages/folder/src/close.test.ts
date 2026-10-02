/**
 * Close Ordering Tests
 *
 * Closing a folder that records its own history fences new file work and
 * aborts network work first. Saves that were already admitted then finish, a
 * commit that was already running finishes, and only then is storage
 * released.
 *
 * Closing makes no last commit. A save that lands after closing began starts
 * no commit attempt and stays uncommitted until a later session's save or an
 * explicit commit.
 *
 * Key behaviors:
 * - Saves in flight when `close()` is called all land, in a browser folder
 *   and in a directory folder, and none of them is committed by closing
 * - While a save is held: new file work, explicit Git, and pushes are
 *   refused or aborted at once, and nothing is released yet
 * - A save's commit attempt that is running when closing starts finishes,
 *   stays local, and storage is released only after it
 * - A batch whose own callback closes the folder is still waited for, and
 *   work that fails as it starts is not left admitted
 *
 * See also:
 * - `git/history.test.ts` for cancelling outgoing work on close
 * - `tauri.test.ts` for a page detaching from the desktop owner
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FileBoundary } from './boundary.js';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from './browser-store.js';
import { defineFolder, defineTable, field } from './contract.js';
import { compileFolderDefinition } from './definition.js';
import { openNativeFolder } from './directory.test-support.js';
import {
	assembleFolder,
	createFileHints,
	createFolderContext,
} from './folder.js';
import type { GitBackend } from './git/backend.js';
import { createBrowserGitBackend } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	id: 'so.epicenter.closetest',
	kv: { theme: field.string() },
	tables: { todos: defineTable({ fields: { title: field.string() } }) },
});
const author = { name: 'Close', email: 'close@example.test' };

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

test('browser saves in flight when the folder closes all land uncommitted, and a commit after reopening records them', async () => {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const open = async () =>
		expectOk(
			await openBrowserFolder({
				definition,
				browser: { author, indexedDb: environment },
			}),
		);
	const folder = await open();

	// Neither is awaited before closing starts: all three are still publishing.
	const saving = folder.files.create('note.md', 'saved as the tab closed');
	const row = folder.tables.todos.create({
		stem: 'last',
		fields: { title: 'Last' },
	});
	const batch = folder.batch((collector) => {
		collector.files.create('audio/last.webm', new Uint8Array([1, 2]));
	});
	const closing = folder.close();
	// Work that arrives after closing started is refused, not admitted late.
	expect(expectErr(await folder.files.create('late.md', 'late')).name).toBe(
		'Closed',
	);
	expectOk(await saving);
	expectOk(await row);
	expectOk(await batch);
	await closing;
	expect(folder.git.snapshot.closed).toBe(true);
	expect(folder.git.snapshot.activity.commit).toEqual({ active: false });

	expect(folder.git.snapshot.lastCommit).toBeUndefined();

	// Reopened, every save is there and closing committed none of them.
	const reopened = await open();
	expect(
		expectOk(await reopened.files.list())
			.files.map((file) => file.path)
			.sort(),
	).toEqual(['audio/last.webm', 'note.md', 'todos/last.md']);
	expect(
		expectOk(await reopened.git.status())
			.changes.map((change) => change.path)
			.sort(),
	).toEqual(['audio/last.webm', 'note.md', 'todos/last.md']);
	expect(await reopened.git.commit()).toMatchObject({
		status: 'committed',
		message: 'Update 3 files',
	});
	expect(expectOk(await reopened.git.status()).changes).toEqual([]);
	await reopened.close();
});

test('a directory save in flight when the folder closes lands and is not committed by closing', async () => {
	const root = await scratch('close-in-flight-');
	const folder = await openNativeFolder({ root, definition, git: { author } });

	const saving = folder.files.create('note.md', 'saved as the tool exited');
	const closing = folder.close();
	expectOk(await saving);
	await closing;

	expect(await git(root, 'rev-list', '--all', '--count')).toBe('0');
	expect(await git(root, 'status', '--porcelain')).toBe('?? note.md');
});

/** A real browser history over a boundary whose next publication the test holds. */
async function held() {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const db = await openFolderDatabase('epicenter-folder:close', environment);
	const base = createBrowserFileBoundary(db, environment);
	const order: string[] = [];
	const { promise: released, resolve: release } = Promise.withResolvers<void>();
	const { promise: reached, resolve: reach } = Promise.withResolvers<void>();
	const rows = {
		/** Set to hold the next directory listing, as a batch's row check makes. */
		hold: undefined as Promise<void> | undefined,
		listing: Promise.withResolvers<void>(),
	};
	const boundary: FileBoundary = {
		...base,
		async children(directory) {
			const hold = rows.hold;
			rows.hold = undefined;
			if (hold !== undefined) {
				rows.listing.resolve();
				await hold;
				order.push('row check done');
			}
			return base.children(directory);
		},
		async apply(changes) {
			reach();
			await released;
			const result = await base.apply(changes);
			order.push('saved');
			return result;
		},
	};
	const real = await createBrowserGitBackend({
		db,
		environment,
		lockName: 'close',
		branch: 'main',
		remote: undefined,
	});
	let pushes = 0;
	const commits = {
		/** Set to hold the next commit just before it moves the branch. */
		hold: undefined as Promise<void> | undefined,
	};
	const backend: GitBackend = {
		...real,
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		async push() {
			pushes++;
		},
		async casBranch(expected, next) {
			await commits.hold;
			const moved = await real.casBranch(expected, next);
			order.push('committed');
			return moved;
		},
	};
	const history = createHistory({
		backend,
		boundary,
		author,
		commitOnEdit: true,
	});
	const folder = assembleFolder<typeof definition>({
		compiled: expectOk(compileFolderDefinition(definition)),
		boundary,
		history,
		location: { kind: 'indexedDb', database: 'epicenter-folder:close' },
		hints: createFileHints(),
		announcePublications: true,
		release: async () => {
			order.push('released');
			db.close();
		},
	});
	return {
		folder,
		order,
		reached,
		release,
		real,
		commits,
		rows,
		base,
		pushes: () => pushes,
	};
}

test('closing fences new work and network at once; the held save lands uncommitted and storage is released last', async () => {
	const { folder, order, reached, release, real, pushes } = await held();
	const snapshots: boolean[] = [];
	folder.git.subscribe((snapshot) => snapshots.push(snapshot.closed));

	const saving = folder.kv.update(expectOk(await folder.kv.get()), {
		theme: 'dark',
	});
	await reached;
	let closed = false;
	const closing = folder.close().then(() => {
		closed = true;
	});

	// The save is still held. Closing has already fenced everything else.
	expect(folder.signal.aborted).toBe(true);
	expect(folder.git.snapshot.closed).toBe(true);
	expect(expectErr(await folder.files.list()).name).toBe('Closed');
	expect(expectErr(await folder.files.create('late.md', 'x')).name).toBe(
		'Closed',
	);
	expect(await folder.git.commit()).toEqual({ status: 'closed' });
	expect(await folder.git.push()).toEqual({ status: 'closed' });
	expect(expectErr(await folder.git.status()).name).toBe('Closed');
	expect(expectErr(await folder.git.fetch()).name).toBe('Closed');
	expect(expectErr(await folder.git.pullFastForward()).name).toBe('Closed');
	expect((await folder.git.commitAndPush()).commit).toEqual({
		status: 'closed',
	});
	await Bun.sleep(20);
	// Nothing was released under the save, and close is still waiting for it.
	expect(closed).toBe(false);
	expect(order).toEqual([]);
	expect(await real.readBranch()).toBeUndefined();

	release();
	const saved = expectOk(await saving);
	await closing;

	expect(saved.values).toEqual({ theme: 'dark' });
	// The save landed after closing began, so it started no commit attempt.
	expect(order).toEqual(['saved', 'released']);
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
	expect(pushes()).toBe(0);
	expect(snapshots.at(-1)).toBe(true);
});

test("a save's commit attempt running when the folder closes finishes and stays local before storage is released", async () => {
	const { folder, order, reached, release, commits, pushes } = await held();
	const { promise: holding, resolve: letGo } = Promise.withResolvers<void>();
	commits.hold = holding;
	const saving = folder.kv.update(expectOk(await folder.kv.get()), {
		theme: 'dark',
	});
	await reached;
	release();
	expectOk(await saving);
	// The save returned; its one attempt is running and held.
	expect(folder.git.snapshot.activity.commit).toEqual({ active: true });

	let closed = false;
	const closing = folder.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);
	expect(order).toEqual(['saved']);

	letGo();
	await closing;
	expect(order).toEqual(['saved', 'committed', 'released']);
	expect(folder.git.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add kv.json',
	});
	// The attempt finished during close, so its commit stayed local.
	expect(pushes()).toBe(0);
});

test('a save refused while closing changes nothing, and close still settles', async () => {
	const { folder, order, reached, release } = await held();
	const refused = folder.files.replace(
		{ path: 'missing.md', version: { sha256: '0'.repeat(64), size: 1 } },
		'x',
	);
	await reached;
	const closing = folder.close();
	release();
	expect(expectErr(await refused).name).toBe('Conflict');
	await closing;
	expect(order).toEqual(['saved', 'released']);
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
	// Closing twice is the same close.
	await folder.close();
	expect(order).toEqual(['saved', 'released']);
});

test('a batch whose callback closes the folder is waited for: its row check and publication finish before storage is released', async () => {
	const { folder, order, release, rows } = await held();
	// Only the row check is held in this test.
	release();
	const { promise: holding, resolve: letGo } = Promise.withResolvers<void>();
	rows.hold = holding;

	let ran = 0;
	let closed = false;
	let closing: Promise<void> | undefined;
	const saving = folder.batch((batch) => {
		ran++;
		batch.tables.todos.create({ stem: 'a', fields: { title: 'Captured' } });
		closing = folder.close().then(() => {
			closed = true;
		});
	});
	// The callback ran, once, before `batch()` returned.
	expect(ran).toBe(1);
	expect(folder.signal.aborted).toBe(true);

	await rows.listing.promise;
	await Bun.sleep(20);
	// The batch is inside its row check. Close is waiting for it.
	expect(closed).toBe(false);
	expect(order).toEqual([]);

	letGo();
	expectOk(await saving);
	await closing;
	expect(ran).toBe(1);
	expect(closed).toBe(true);
	expect(order).toEqual(['row check done', 'saved', 'released']);
	// The save landed after closing began, so no commit was attempted.
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
});

test('work that fails as it starts is not left admitted and rejects only once', async () => {
	const unhandled: unknown[] = [];
	const listen = (cause: unknown) => unhandled.push(cause);
	process.on('unhandledRejection', listen);
	try {
		// A batch callback that throws: the batch reports it and close is not held.
		const { folder, order } = await held();
		const failed = expectErr(
			await folder.batch(() => {
				throw new Error('callback failed');
			}),
		);
		expect(failed.name).toBe('Threw');
		await folder.close();
		expect(order).toEqual(['released']);

		// Work that throws before it returns a promise: one rejection, the
		// caller's, and nothing left for `settled` to wait on.
		const { base } = await held();
		const context = createFolderContext({
			boundary: base,
			history: { noteEdit() {}, requestAutomaticCommit() {} },
			signal: new AbortController().signal,
			landed() {},
		});
		const rejected = context.admit(() => {
			throw new Error('threw as it started');
		});
		await expect(rejected).rejects.toThrow('threw as it started');
		await context.settled();
		await Bun.sleep(10);
		expect(unhandled).toEqual([]);
	} finally {
		process.off('unhandledRejection', listen);
	}
});

test('close reentered by abort and history observers shares one completion and releases once', async () => {
	const { folder, order } = await held();
	let fromAbort: Promise<void> | undefined;
	let fromHistory: Promise<void> | undefined;
	folder.signal.addEventListener('abort', () => {
		fromAbort = folder.close();
	});
	const unsubscribe = folder.git.subscribe((snapshot) => {
		if (snapshot.closed) fromHistory = folder.close();
	});

	const closing = folder.close();
	expect(fromAbort).toBe(closing);
	expect(fromHistory).toBe(closing);
	await closing;
	unsubscribe();
	expect(order).toEqual(['released']);
	expect(folder.close()).toBe(closing);
});

// Automatic commits need the shared lock; this runtime has none of its own.
useWebLocks();
