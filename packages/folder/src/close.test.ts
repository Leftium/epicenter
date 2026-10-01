/**
 * Close Ordering Tests
 *
 * Closing a folder that records its own history fences new file work and
 * stops network work first. Saves that were already admitted then finish and
 * request their local commits, and only after that are the local commit
 * passes drained and storage released.
 *
 * The regression these pin: history used to stop accepting commit requests
 * the moment closing began, so a save still in flight landed its bytes and
 * was never committed.
 *
 * Key behaviors:
 * - A save in flight when `close()` is called is committed locally before
 *   `close()` resolves, in a browser folder and in a directory folder
 * - While that save is held: new file work, explicit Git, and pushes are
 *   refused or cancelled at once, and nothing is released yet
 * - The commit a closing save requested does not push
 * - Storage is released only after the commit pass finished
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
	createLocalTerminal,
} from './folder.js';
import type { GitBackend } from './git/backend.js';
import { createBrowserGitBackend } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';

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

test('a browser save in flight when the folder closes is committed before close resolves', async () => {
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
	expect(folder.git.snapshot.activity.commit).toEqual({
		active: false,
		pending: false,
	});

	// Reopened, the saves are history, not uncommitted changes left behind.
	const reopened = await open();
	const log = expectOk(await reopened.git.log(10));
	expect(log.length).toBeGreaterThan(0);
	expect(expectOk(await reopened.git.status()).changes).toEqual([]);
	expect(
		expectOk(await reopened.files.list())
			.files.map((file) => file.path)
			.sort(),
	).toEqual(['audio/last.webm', 'note.md', 'todos/last.md']);
	await reopened.close();
});

test('a directory save in flight when the folder closes is committed before close resolves', async () => {
	const root = await scratch('close-pending-');
	const folder = await openNativeFolder({ root, definition, git: { author } });

	const saving = folder.files.create('note.md', 'saved as the tool exited');
	const closing = folder.close();
	expectOk(await saving);
	await closing;

	expect(await git(root, 'log', '--format=%s')).toBe('Add note.md');
	expect(await git(root, 'status', '--porcelain')).toBe('');
});

/** A real browser history over a boundary whose next publication the test holds. */
async function held() {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const db = await openFolderDatabase('epicenter-folder:close', environment);
	const base = createBrowserFileBoundary(db, environment);
	const order: string[] = [];
	const { promise: released, resolve: release } = Promise.withResolvers<void>();
	const { promise: reached, resolve: reach } = Promise.withResolvers<void>();
	const boundary: FileBoundary = {
		...base,
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
	const backend: GitBackend = {
		...real,
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		async push() {
			pushes++;
		},
		async casBranch(expected, next) {
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
		terminal: createLocalTerminal,
		release: async () => {
			order.push('released');
			db.close();
		},
	});
	return { folder, order, reached, release, real, pushes: () => pushes };
}

test('closing fences new work and network at once, then the held save lands, is committed without a push, and storage is released last', async () => {
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
	// The save landed, its commit request was accepted and ran, and only then
	// was storage released.
	expect(order).toEqual(['saved', 'committed', 'released']);
	expect(folder.git.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add kv.json',
	});
	// A commit that finishes while closing stays local.
	expect(pushes()).toBe(0);
	expect(folder.git.snapshot.lastPush).toBeUndefined();
	expect(snapshots.at(-1)).toBe(true);
});

test('a save refused while closing requests no commit, and close still settles', async () => {
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
