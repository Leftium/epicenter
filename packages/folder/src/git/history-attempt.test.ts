/**
 * Commit-On-Edit Attempt Tests
 *
 * With `commitOnEdit`, each save this handle published makes one commit
 * attempt. The attempt takes the backend's protection only if it is free at
 * that moment. These tests pin what that promises and what it does not.
 *
 * Key behaviors:
 * - One published save makes one attempt; its subject and count come from
 *   the committed tree
 * - Held protection (another tab's Web Lock, this handle's pull, path
 *   listing, or running commit) means the attempt did not happen: the save is
 *   kept, no outcome is recorded, and nothing runs when the protection frees
 * - The next save or an explicit commit captures the latest saved input
 * - A write nobody published through this handle, and `noteEdit` alone, make
 *   no attempt
 * - A failed attempt records the error, keeps the files, and is not retried
 * - `commit()` is local; an attempt pushes only when the branch is ahead and
 *   no push is running; a caller that stopped waiting on `commitAndPush`
 *   starts no push later
 * - Closing refuses a request still waiting for the protection without moving
 *   the branch, waits for work already inside it, and makes no last commit
 * - Two tabs, real Git locks, and many callers leave a branch that only ever
 *   moved by compare-and-swap
 *
 * See also:
 * - `history-ordering.test.ts` for capture ordering inside the Git lock
 * - `batch.test.ts` and `browser.test.ts` for partial and refused saves
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from '../browser-store.js';
import { defineFolder, field } from '../contract.js';
import { openNativeFolder } from '../directory.test-support.js';
import { GIT_ENV, git, scratch } from '../git-http.test-support.js';
import { hashBytes } from '../capture.js';
import {
	installWebLocks,
	useWebLocks,
	withoutWebLocks,
} from '../web-locks.test-support.js';
import type { GitBackend } from './backend.js';
import { createBrowserGitBackend } from './browser-backend.js';
import { createHistory } from './history.js';
import { commitTree, readBlob, readTreeFiles } from './objects.js';

const author = { name: 'History', email: 'history@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const definition = defineFolder({
	id: 'so.epicenter.attempt',
	kv: { theme: field.string() },
	tables: {},
});

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

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function until(condition: () => boolean) {
	for (let index = 0; index < 200 && !condition(); index++) await Bun.sleep(2);
	expect(condition()).toBe(true);
}

/**
 * One browser tab's history over the shared store named `name`.
 * `probe.hold` stops the next commit after it captured and wrote its commit,
 * just before the branch moves. `holds` stop the named backend call.
 */
async function tab(
	environment: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange },
	name: string,
	{ commitOnEdit = true } = {},
) {
	const db = await openFolderDatabase(`epicenter-folder:${name}`, environment);
	const base = createBrowserFileBoundary(db, environment);
	const holds: {
		pathStatus?: ReturnType<typeof gate>;
		readRemoteTracking?: ReturnType<typeof gate>;
		/** Holds a capture after it read the folder, before it returns. */
		captured?: ReturnType<typeof gate>;
		/** Holds a push or fetch inside its transport. */
		transport?: ReturnType<typeof gate>;
	} = {};
	const entered = gate();
	async function heldAt(key: keyof typeof holds) {
		const hold = holds[key];
		holds[key] = undefined;
		if (hold === undefined) return;
		entered.open();
		await hold.opened;
	}
	const real = await createBrowserGitBackend({
		db,
		environment,
		lockName: name,
		branch: 'main',
		remote: undefined,
	});
	const probe = {
		/** Automatic attempts made, admitted or not. */
		attempts: 0,
		/** Commits that reached the branch compare-and-swap. */
		publications: 0,
		pushes: 0,
		fetches: 0,
		/** Whole-folder reads, by a scan or a commit. */
		captures: 0,
		/** Object-store sessions opened, by a scan or a commit. */
		objectSessions: 0,
		/** What the remote holds, as the tracking ref would record it. */
		remoteHead: undefined as string | undefined,
		offline: false,
		hold: undefined as ReturnType<typeof gate> | undefined,
		reached: gate(),
	};
	const boundary: typeof base = {
		...base,
		async capture() {
			probe.captures++;
			const captured = await base.capture();
			await heldAt('captured');
			return captured;
		},
	};
	const backend: GitBackend = {
		...real,
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		tryExclusive(work) {
			probe.attempts++;
			return real.tryExclusive(work);
		},
		withObjects(work) {
			probe.objectSessions++;
			return real.withObjects(work);
		},
		async fetch() {
			probe.fetches++;
			await heldAt('transport');
			return probe.remoteHead;
		},
		async readRemoteTracking() {
			await heldAt('readRemoteTracking');
			return probe.remoteHead;
		},
		async pathStatus() {
			await heldAt('pathStatus');
			return real.pathStatus();
		},
		async push(oid) {
			probe.pushes++;
			await heldAt('transport');
			if (probe.offline) throw new Error('offline');
			probe.remoteHead = oid;
		},
		async casBranch(expected, next) {
			probe.publications++;
			const hold = probe.hold;
			probe.hold = undefined;
			if (hold !== undefined) {
				probe.reached.open();
				await hold.opened;
			}
			return real.casBranch(expected, next);
		},
	};
	const history = createHistory({ backend, boundary, author, commitOnEdit });
	async function land(path: string, text: string) {
		const bytes = encoder.encode(text);
		const applied = await boundary.apply([
			{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
		]);
		expect(applied.error).toBeNull();
	}
	/** A complete save as the folder publishes it: land, note, one attempt. */
	async function save(path: string, text: string) {
		await land(path, text);
		history.noteEdit();
		history.requestAutomaticCommit();
	}
	/** Wait until no commit or push of this handle is in flight. */
	async function idle() {
		await Bun.sleep(0);
		await until(
			() =>
				!history.snapshot.activity.commit.active &&
				!history.snapshot.activity.push.active,
		);
	}
	/** The committed files at the branch head, as text. */
	async function committed() {
		const head = await real.readBranch();
		if (head === undefined) return {};
		return real.withObjects(async (access) => {
			const files = await readTreeFiles(access, await commitTree(access, head));
			const entries: [string, string][] = [];
			for (const [path, file] of files)
				entries.push([path, decoder.decode(await readBlob(access, file.oid))]);
			return Object.fromEntries(entries);
		});
	}
	/** The saved files in the folder, as text. */
	async function saved() {
		const captured = expectOk(await base.capture());
		return Object.fromEntries(
			[...captured.files].map(([path, bytes]) => [path, decoder.decode(bytes)]),
		);
	}
	return {
		db,
		real,
		history,
		probe,
		holds,
		entered: entered.opened,
		land,
		save,
		idle,
		committed,
		saved,
	};
}

const freshEnvironment = () => ({ indexedDB: new IDBFactory(), IDBKeyRange });

// Automatic commits need the shared lock; this runtime has none of its own.
useWebLocks();

// ============================================================================
// One attempt per published save
// ============================================================================

test('a published save makes one attempt that commits the folder with a subject from the committed tree', async () => {
	const { db, history, probe, save, idle, committed } = await tab(
		freshEnvironment(),
		'one-attempt',
	);
	await save('a.txt', 'one');
	// The save returned; its attempt is in flight.
	expect(history.snapshot.activity.commit).toEqual({ active: true });
	await idle();
	expect(probe.attempts).toBe(1);
	expect(probe.publications).toBe(1);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add a.txt',
		changedPaths: 1,
	});
	expect(await committed()).toEqual({ 'a.txt': 'one' });
	// The branch was ahead and no push was running, so one push went out.
	expect(probe.pushes).toBe(1);

	// Nothing else happens until the next save.
	await Bun.sleep(30);
	expect(probe.attempts).toBe(1);
	await history.close();
	db.close();
});

test('with commitOnEdit off, a save makes no attempt', async () => {
	const { db, history, probe, save } = await tab(freshEnvironment(), 'off', {
		commitOnEdit: false,
	});
	await save('a.txt', 'one');
	await Bun.sleep(20);
	expect(probe.attempts).toBe(0);
	expect(history.snapshot.lastCommit).toBeUndefined();
	await history.close();
	db.close();
});

test('a write this handle did not publish, and a noted edit alone, make no attempt', async () => {
	const environment = freshEnvironment();
	const mine = await tab(environment, 'external');
	const other = await tab(environment, 'external', { commitOnEdit: false });
	// Another tab writes to the shared store; this handle only hears a hint.
	await other.land('a.txt', 'from another tab');
	// A partial publication notes the edit and asks for nothing.
	mine.history.noteEdit();
	await Bun.sleep(30);
	expect(mine.probe.attempts).toBe(0);
	expect(mine.history.snapshot.lastCommit).toBeUndefined();
	expect(await mine.committed()).toEqual({});

	// The next save this handle publishes commits the folder as it is.
	await mine.save('b.txt', 'mine');
	await mine.idle();
	expect(mine.history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
		changedPaths: 2,
	});
	await mine.history.close();
	await other.history.close();
	mine.db.close();
	other.db.close();
});

// ============================================================================
// Held protection: the attempt did not happen
// ============================================================================

test("a save during this handle's held commit is kept, makes no commit when that one finishes, and the next save captures it", async () => {
	const { db, history, probe, save, idle, committed, saved } = await tab(
		freshEnvironment(),
		'held-own',
	);
	const held = gate();
	probe.hold = held;
	await save('a.txt', 'one');
	await probe.reached.opened;

	// The held commit already captured `one`. This save's attempt is refused.
	await save('a.txt', 'two');
	expect(probe.attempts).toBe(2);
	held.open();
	await idle();
	await Bun.sleep(30);
	expect(probe.publications).toBe(1);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add a.txt',
	});
	expect(await committed()).toEqual({ 'a.txt': 'one' });
	expect(await saved()).toEqual({ 'a.txt': 'two' });
	// The snapshot does not call the folder clean.
	const files = history.snapshot.files;
	expect(files.state === 'observed' && files.stale).toBe(true);

	// The next owned save commits the latest of both files.
	await save('b.txt', 'new');
	await idle();
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
		changedPaths: 2,
	});
	expect(await committed()).toEqual({ 'a.txt': 'two', 'b.txt': 'new' });
	await history.close();
	db.close();
});

test('while another tab holds the Web Lock, a save is kept, records nothing, and is not committed when the lock frees', async () => {
	const restore = installWebLocks();
	try {
		const environment = freshEnvironment();
		const a = await tab(environment, 'locked-tabs');
		const b = await tab(environment, 'locked-tabs');
		const held = gate();
		a.probe.hold = held;
		await a.save('a.txt', 'from a');
		await a.probe.reached.opened;

		await b.save('b.txt', 'from b');
		await b.idle();
		expect(b.probe.attempts).toBe(1);
		expect(b.history.snapshot.lastCommit).toBeUndefined();
		expect(b.history.snapshot.lastPush).toBeUndefined();

		held.open();
		await a.idle();
		const first = a.history.snapshot.lastCommit;
		expect(first).toMatchObject({ status: 'committed', message: 'Add a.txt' });
		// The lock is free and nothing of tab B's runs on its own.
		await Bun.sleep(30);
		expect(b.probe.publications).toBe(0);
		expect(b.history.snapshot.lastCommit).toBeUndefined();
		expect(await a.committed()).toEqual({ 'a.txt': 'from a' });
		expect(await b.saved()).toEqual({ 'a.txt': 'from a', 'b.txt': 'from b' });

		// An explicit commit captures it, on top of tab A's commit.
		expect(await b.history.commit()).toMatchObject({
			status: 'committed',
			message: 'Add b.txt',
			parent: first?.status === 'committed' ? first.oid : undefined,
		});
		await a.history.close();
		await b.history.close();
		a.db.close();
		b.db.close();
	} finally {
		restore();
	}
});

test("a save during this handle's held pull or path listing makes no commit, then or later", async () => {
	const restore = installWebLocks();
	try {
		const { db, history, probe, holds, entered, save, idle, committed } =
			await tab(freshEnvironment(), 'own-lock');

		// A pull holds the protection while it reads the fetched head.
		const pulling = gate();
		holds.readRemoteTracking = pulling;
		const pull = history.pullFastForward();
		await entered;
		await save('a.txt', 'one');
		await Bun.sleep(10);
		expect(probe.attempts).toBe(1);
		pulling.open();
		expect((await pull).error?.name).toBe('NoFetchedHead');
		await Bun.sleep(30);
		expect(probe.publications).toBe(0);
		expect(history.snapshot.lastCommit).toBeUndefined();
		expect(await committed()).toEqual({});

		// So does an explicit path listing.
		const listing = gate();
		holds.pathStatus = listing;
		const paths = history.paths();
		await until(() => holds.pathStatus === undefined);
		await save('a.txt', 'two');
		await Bun.sleep(10);
		listing.open();
		expectOk(await paths);
		await Bun.sleep(30);
		expect(probe.attempts).toBe(2);
		expect(probe.publications).toBe(0);
		expect(history.snapshot.lastCommit).toBeUndefined();

		// Nothing holds it now: the next save's attempt commits the latest.
		await save('b.txt', 'new');
		await idle();
		expect(history.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Update 2 files',
		});
		expect(await committed()).toEqual({ 'a.txt': 'two', 'b.txt': 'new' });
		await history.close();
		db.close();
	} finally {
		restore();
	}
});

test('an explicit commit during a held attempt waits and captures a save made while it waited', async () => {
	const { db, history, probe, save, committed } = await tab(
		freshEnvironment(),
		'explicit-waits',
	);
	probe.offline = true;
	const held = gate();
	probe.hold = held;
	await save('a.txt', 'one');
	await probe.reached.opened;

	let outcome: Awaited<ReturnType<typeof history.commit>> | undefined;
	const explicit = history.commit().then((value) => {
		outcome = value;
	});
	await Bun.sleep(20);
	expect(outcome).toBeUndefined();
	// Saved after the request, while it waits.
	await save('b.txt', 'while waiting');

	held.open();
	await explicit;
	expect(outcome).toMatchObject({ status: 'committed', message: 'Add b.txt' });
	expect(probe.publications).toBe(2);
	expect(await committed()).toEqual({
		'a.txt': 'one',
		'b.txt': 'while waiting',
	});
	await until(() => !history.snapshot.activity.push.active);
	// Only the save's attempt tried to push; the explicit commit stayed local.
	expect(probe.pushes).toBe(1);
	await history.close();
	db.close();
});

// ============================================================================
// Pushing
// ============================================================================

test("a failed push is not owed; the next save's attempt pushes because the branch is ahead", async () => {
	const { db, history, probe, save, idle } = await tab(
		freshEnvironment(),
		'push-again',
	);
	probe.offline = true;
	await save('a.txt', 'one');
	await idle();
	expect(history.snapshot.lastPush?.status).toBe('failed');
	expect(probe.pushes).toBe(1);

	// Nothing tries again on its own.
	await Bun.sleep(30);
	expect(probe.pushes).toBe(1);

	probe.offline = false;
	await save('a.txt', 'two');
	await idle();
	expect(history.snapshot.lastPush?.status).toBe('pushed');
	expect(probe.pushes).toBe(2);
	const sync = history.snapshot.sync;
	expect(sync.state === 'observed' && sync.value.ahead).toBe(0);
	await history.close();
	db.close();
});

test('explicit commit is local; commitAndPush pushes', async () => {
	const { db, history, probe, land } = await tab(
		freshEnvironment(),
		'explicit-local',
		{ commitOnEdit: false },
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	await Bun.sleep(20);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastPush).toBeUndefined();

	await land('a.txt', 'two');
	const both = await history.commitAndPush();
	expect(both.commit.status).toBe('committed');
	expect(both.push.status).toBe('pushed');
	expect(probe.pushes).toBe(1);
	await history.close();
	db.close();
});

test('a caller that stops waiting on commitAndPush leaves its commit to finish and starts no push later', async () => {
	const { db, history, probe, land, committed } = await tab(
		freshEnvironment(),
		'abandoned',
		{ commitOnEdit: false },
	);
	await land('a.txt', 'one');
	const held = gate();
	probe.hold = held;
	const caller = new AbortController();
	const waiting = history.commitAndPush({ signal: caller.signal });
	await probe.reached.opened;
	caller.abort();
	expect(await waiting).toEqual({
		commit: { status: 'stoppedWaiting' },
		push: { status: 'stoppedWaiting' },
	});

	// The commit was already inside the protection: it finishes and reports.
	held.open();
	await until(() => history.snapshot.lastCommit !== undefined);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add a.txt',
	});
	expect(await committed()).toEqual({ 'a.txt': 'one' });
	await Bun.sleep(30);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastPush).toBeUndefined();
	await history.close();
	db.close();
});

// ============================================================================
// Closing
// ============================================================================

test("closing refuses an explicit commit still waiting on another tab's Web Lock, resolves without it, and the branch is not moved by it", async () => {
	const restore = installWebLocks();
	try {
		const environment = freshEnvironment();
		const a = await tab(environment, 'close-waiting');
		const b = await tab(environment, 'close-waiting', { commitOnEdit: false });
		const held = gate();
		a.probe.hold = held;
		await a.save('a.txt', 'from a');
		await a.probe.reached.opened;

		await b.land('b.txt', 'from b');
		const waiting = b.history.commit();
		const listing = b.history.paths();
		await Bun.sleep(20);
		expect(b.history.snapshot.activity.commit).toEqual({ active: true });

		// Tab A still holds the lock. Tab B closes without waiting for it.
		await b.history.close();
		expect(await waiting).toEqual({ status: 'closed' });
		expect((await listing).error?.name).toBe('Closed');
		expect(b.history.snapshot.activity.commit).toEqual({ active: false });
		expect(b.history.snapshot.lastCommit).toBeUndefined();

		held.open();
		await a.idle();
		await Bun.sleep(30);
		// Tab B's commit never ran, not even after the lock was freed.
		expect(b.probe.publications).toBe(0);
		expect(await a.committed()).toEqual({ 'a.txt': 'from a' });
		expect(await a.saved()).toEqual({ 'a.txt': 'from a', 'b.txt': 'from b' });
		await a.history.close();
		a.db.close();
		b.db.close();
	} finally {
		restore();
	}
});

test('closing waits for an attempt already inside the protection, refuses a commit waiting behind it, and makes no last commit', async () => {
	const restore = installWebLocks();
	try {
		const { db, history, probe, save, committed, saved } = await tab(
			freshEnvironment(),
			'close-admitted',
		);
		const held = gate();
		probe.hold = held;
		await save('a.txt', 'one');
		await probe.reached.opened;
		await save('b.txt', 'late');
		// Asked for before closing, still waiting behind the held attempt.
		const waiting = history.commit();

		history.beginClose();
		expect(history.snapshot.closed).toBe(true);
		expect(await waiting).toEqual({ status: 'closed' });
		expect(await history.commit()).toEqual({ status: 'closed' });
		expect((await history.status()).error?.name).toBe('Closed');
		let closed = false;
		const closing = history.close().then(() => {
			closed = true;
		});
		// A save that lands after closing began makes no attempt.
		const before = probe.attempts;
		await save('c.txt', 'later still');
		expect(probe.attempts).toBe(before);
		await Bun.sleep(20);
		// The admitted attempt still uses storage; close has not resolved.
		expect(closed).toBe(false);

		held.open();
		await closing;
		expect(probe.publications).toBe(1);
		expect(history.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Add a.txt',
		});
		expect(history.snapshot.activity).toEqual({
			scan: { active: false },
			commit: { active: false },
			push: { active: false },
			fetch: { active: false },
			pull: { active: false },
			merge: { active: false },
		});
		// The commit that finished during close stayed local.
		expect(probe.pushes).toBe(0);
		expect(await committed()).toEqual({ 'a.txt': 'one' });
		expect(await saved()).toEqual({
			'a.txt': 'one',
			'b.txt': 'late',
			'c.txt': 'later still',
		});
		db.close();
	} finally {
		restore();
	}
});

// ============================================================================
// A browser with no Web Locks
// ============================================================================

test('without Web Locks, a save makes no commit and touches nothing of Git; the file is kept and the observation goes stale', async () => {
	const { db, history, probe, save, saved, committed } = await tab(
		freshEnvironment(),
		'no-locks',
	);
	expectOk(await history.status());
	const before = { ...probe };
	await withoutWebLocks(async () => {
		await save('a.txt', 'one');
		await Bun.sleep(30);
	});
	// The attempt was made and refused before any Git work began.
	expect(probe.attempts).toBe(before.attempts + 1);
	expect(probe.captures).toBe(before.captures);
	expect(probe.objectSessions).toBe(before.objectSessions);
	expect(probe.publications).toBe(0);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastCommit).toBeUndefined();
	expect(history.snapshot.lastPush).toBeUndefined();
	expect(history.snapshot.activity.commit).toEqual({ active: false });
	expect(await committed()).toEqual({});
	// The save is intact, and the snapshot no longer calls the folder clean.
	expect(await saved()).toEqual({ 'a.txt': 'one' });
	expect(history.snapshot.files).toMatchObject({
		state: 'observed',
		stale: true,
		error: undefined,
	});
	await history.close();
	db.close();
});

test('without Web Locks, explicit commits still run in each tab, and the stored compare-and-swap refuses the loser and forces nothing', async () => {
	await withoutWebLocks(async () => {
		const environment = freshEnvironment();
		const a = await tab(environment, 'tabs', { commitOnEdit: false });
		const b = await tab(environment, 'tabs', { commitOnEdit: false });
		await a.land('a.txt', 'from a');
		const held = gate();
		a.probe.hold = held;
		const losing = a.history.commit();
		await a.probe.reached.opened;

		// Tab B commits while A sits between capture and publication. Nothing
		// orders the two tabs here except the branch itself.
		await b.land('b.txt', 'from b');
		const winner = await b.history.commit();
		expect(winner.status).toBe('committed');
		const winning = winner.status === 'committed' ? winner.oid : undefined;

		held.open();
		expect(await losing).toMatchObject({
			status: 'branchMoved',
			expected: undefined,
			actual: winning,
		});
		expect(await a.real.readBranch()).toBe(winning);
		expect(await a.committed()).toEqual({
			'a.txt': 'from a',
			'b.txt': 'from b',
		});
		// Nothing retried for tab A.
		await Bun.sleep(20);
		expect(a.probe.publications).toBe(1);
		expect((await a.history.commit()).status).toBe('unchanged');
		await a.history.close();
		await b.history.close();
		a.db.close();
		b.db.close();
	});
});

// ============================================================================
// Status scans
// ============================================================================

test('status requests during a held scan share one following scan, which reads the last saved edit; nothing is committed or pushed', async () => {
	const { db, history, probe, holds, land } = await tab(
		freshEnvironment(),
		'scan-burst',
	);
	await land('a.txt', 'one');
	const scanning = gate();
	holds.captured = scanning;
	const first = history.status();
	await until(() => holds.captured === undefined);
	expect(probe.captures).toBe(1);

	// A burst while the first scan is held after it read the folder.
	await land('b.txt', 'two');
	const burst = [history.status(), history.status(), history.status()];
	await land('c.txt', 'last');
	burst.push(history.status());
	await Bun.sleep(20);
	// None of them joined the running scan and none started another.
	expect(probe.captures).toBe(1);

	scanning.open();
	// The held scan reports what it read before the burst.
	expect(expectOk(await first).changes.map((change) => change.path)).toEqual([
		'a.txt',
	]);
	const results = await Promise.all(burst);
	const paths = results.map((result) =>
		expectOk(result).changes.map((change) => change.path),
	);
	for (const seen of paths) expect(seen).toEqual(['a.txt', 'b.txt', 'c.txt']);
	// One scan followed for all four callers.
	expect(probe.captures).toBe(2);
	const files = history.snapshot.files;
	expect(files).toMatchObject({ state: 'observed', stale: false });
	expect(
		files.state === 'observed' && files.value.changes.map((c) => c.path),
	).toEqual(['a.txt', 'b.txt', 'c.txt']);

	// The shared scan left no commit, push, or later work behind.
	await Bun.sleep(30);
	expect(probe.captures).toBe(2);
	expect(probe.attempts).toBe(0);
	expect(probe.publications).toBe(0);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastCommit).toBeUndefined();
	// A request after the burst gets a scan of its own.
	expectOk(await history.status());
	expect(probe.captures).toBe(3);
	await history.close();
	db.close();
});

test('closing waits for the running scan and refuses the scan waiting behind it', async () => {
	const { db, history, probe, holds, land } = await tab(
		freshEnvironment(),
		'scan-close',
	);
	await land('a.txt', 'one');
	const scanning = gate();
	holds.captured = scanning;
	const first = history.status();
	await until(() => holds.captured === undefined);
	const following = [history.status(), history.status()];

	let closed = false;
	const closing = history.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);
	scanning.open();
	await closing;
	expectOk(await first);
	for (const result of await Promise.all(following))
		expect(result.error?.name).toBe('Closed');
	expect(probe.captures).toBe(1);
	db.close();
});

// ============================================================================
// A caller that leaves a queued push or fetch
// ============================================================================

test('a push whose caller leaves while it is queued behind a held push starts no transport when the holder finishes', async () => {
	const { db, history, probe, holds, land } = await tab(
		freshEnvironment(),
		'push-queued',
		{ commitOnEdit: false },
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const transport = gate();
	holds.transport = transport;
	const holder = history.push();
	await until(() => holds.transport === undefined);
	expect(probe.pushes).toBe(1);

	const caller = new AbortController();
	const queued = history.push({ signal: caller.signal });
	await Bun.sleep(10);
	caller.abort();
	expect(await queued).toEqual({ status: 'stoppedWaiting' });

	transport.open();
	expect((await holder).status).toBe('pushed');
	await Bun.sleep(30);
	// The caller that left never got a transport of its own.
	expect(probe.pushes).toBe(1);
	expect(history.snapshot.activity.push).toEqual({ active: false });
	expect(history.snapshot.lastPush?.status).toBe('pushed');
	await history.close();
	db.close();
});

test('a push asked for with an already aborted signal starts no transport', async () => {
	const { db, history, probe, land } = await tab(
		freshEnvironment(),
		'push-aborted',
		{ commitOnEdit: false },
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const caller = new AbortController();
	caller.abort();
	expect(await history.push({ signal: caller.signal })).toEqual({
		status: 'stoppedWaiting',
	});
	await Bun.sleep(30);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastPush).toBeUndefined();
	// The runner is not left holding anything: a plain push goes out.
	expect((await history.push()).status).toBe('pushed');
	expect(probe.pushes).toBe(1);
	await history.close();
	db.close();
});

test('a caller that leaves commitAndPush while its push is queued keeps its commit and starts no transport', async () => {
	const { db, history, probe, holds, land } = await tab(
		freshEnvironment(),
		'both-queued',
		{ commitOnEdit: false },
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const transport = gate();
	holds.transport = transport;
	const holder = history.push();
	await until(() => holds.transport === undefined);

	await land('b.txt', 'two');
	const caller = new AbortController();
	const both = history.commitAndPush({ signal: caller.signal });
	// Wait for this commit, not the earlier commit whose push is still held.
	await until(() => {
		const committed = history.snapshot.lastCommit;
		return (
			committed?.status === 'committed' && committed.message === 'Add b.txt'
		);
	});
	caller.abort();
	expect(await both).toMatchObject({
		commit: { status: 'committed', message: 'Add b.txt' },
		push: { status: 'stoppedWaiting' },
	});

	transport.open();
	await holder;
	await Bun.sleep(30);
	expect(probe.pushes).toBe(1);
	await history.close();
	db.close();
});

test('a caller that leaves after its push started is told so; the transport finishes and close waits for one that has not', async () => {
	const { db, history, probe, holds, land } = await tab(
		freshEnvironment(),
		'push-admitted',
		{ commitOnEdit: false },
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const transport = gate();
	holds.transport = transport;
	const caller = new AbortController();
	const admitted = history.push({ signal: caller.signal });
	await until(() => holds.transport === undefined);
	caller.abort();
	// The caller stopped waiting; the host did not cancel anything.
	expect(await admitted).toEqual({ status: 'stoppedWaiting' });
	expect(history.snapshot.activity.push).toEqual({ active: true });

	let closed = false;
	const closing = history.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);
	transport.open();
	await closing;
	expect(probe.pushes).toBe(1);
	expect(history.snapshot.lastPush?.status).toBe('pushed');
	db.close();
});

test('a fetch whose caller leaves while it is queued, or before it asks, starts no transport', async () => {
	const { db, history, probe, holds } = await tab(
		freshEnvironment(),
		'fetch-queued',
		{ commitOnEdit: false },
	);
	const transport = gate();
	holds.transport = transport;
	const holder = history.fetch();
	await until(() => holds.transport === undefined);
	expect(probe.fetches).toBe(1);

	const caller = new AbortController();
	const queued = history.fetch({ signal: caller.signal });
	await Bun.sleep(10);
	caller.abort();
	expect((await queued).error?.name).toBe('StoppedWaiting');
	expect((await history.fetch({ signal: caller.signal })).error?.name).toBe(
		'StoppedWaiting',
	);

	transport.open();
	expectOk(await holder);
	await Bun.sleep(30);
	expect(probe.fetches).toBe(1);
	expect(history.snapshot.activity.fetch).toEqual({ active: false });
	await history.close();
	db.close();
});

// ============================================================================
// A directory with the real `git`
// ============================================================================

async function directory(prefix: string, commitOnEdit: boolean) {
	const root = await scratch(prefix);
	const open = () =>
		openNativeFolder({ root, definition, git: { author, commitOnEdit } });
	return { root, open, folder: await open() };
}

async function settled(
	folder: Awaited<ReturnType<typeof directory>>['folder'],
) {
	await Bun.sleep(0);
	await until(() => !folder.git.snapshot.activity.commit.active);
}

test('a held ref lock fails the attempt, records the error, keeps the save, and nothing retries until the next save', async () => {
	const { root, folder } = await directory('attempt-ref-lock-', true);
	expectOk(await folder.files.create('a.md', 'first'));
	await settled(folder);
	const head = await git(root, 'rev-parse', 'HEAD');

	const lock = join(root, '.git', 'refs', 'heads', 'main.lock');
	await writeFile(lock, '');
	expectOk(await folder.files.create('b.md', 'saved under a lock'));
	await settled(folder);
	const failed = folder.git.snapshot.lastCommit;
	expect(failed?.status).toBe('failed');
	expect(failed?.status === 'failed' && failed.error).toContain('main.lock');
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
	expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('saved under a lock');
	expect(await git(root, 'status', '--porcelain')).toBe('?? b.md');

	await rm(lock);
	await Bun.sleep(60);
	// The lock is gone and nothing ran on its own.
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
	expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
	expect(folder.git.snapshot.lastCommit?.status).toBe('failed');

	// The next save's attempt commits both.
	expectOk(await folder.files.create('c.md', 'next'));
	await settled(folder);
	expect(folder.git.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
		changedPaths: 2,
		parent: head,
	});
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await folder.close();
});

test('a held index lock still commits, reports the index warning, and the next commit repairs it', async () => {
	const { root, folder } = await directory('attempt-index-lock-', true);
	expectOk(await folder.files.create('a.md', 'first'));
	await settled(folder);

	const lock = join(root, '.git', 'index.lock');
	await writeFile(lock, '');
	expectOk(await folder.files.create('b.md', 'second'));
	await settled(folder);
	const committed = folder.git.snapshot.lastCommit;
	expect(committed).toMatchObject({ status: 'committed', message: 'Add b.md' });
	expect(committed?.status === 'committed' && committed.indexWarning).toContain(
		'index.lock',
	);
	expect(await git(root, 'show', 'HEAD:b.md')).toBe('second');
	// The index is behind the branch, not corrupt: Git still reads it.
	await rm(lock);
	expect(await git(root, 'status', '--porcelain')).toBe('D  b.md\n?? b.md');

	expect(await folder.git.commit()).toMatchObject({
		status: 'unchanged',
		indexWarning: undefined,
	});
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await folder.close();
});

test('many callers in one handle and across two each take a commit and leave a linear branch, sound objects, and a usable index', async () => {
	const { root, open, folder: one } = await directory('attempt-many-', false);
	const two = await open();
	const tally: Record<string, number> = {};
	const committedOids: string[] = [];
	for (let round = 0; round < 8; round++) {
		await writeFile(join(root, `note-${round % 3}.md`), `round ${round}`);
		const outcomes = await Promise.all([
			...Array.from({ length: 3 }, () => one.git.commit()),
			...Array.from({ length: 3 }, () => two.git.commit()),
			one.git.commitAndPush().then((both) => both.commit),
		]);
		for (const outcome of outcomes) {
			tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
			if (outcome.status === 'committed') committedOids.push(outcome.oid);
			// Every caller is told what its own commit did.
			expect(['committed', 'unchanged', 'branchMoved', 'failed']).toContain(
				outcome.status,
			);
		}
		expect(await readFile(join(root, `note-${round % 3}.md`), 'utf8')).toBe(
			`round ${round}`,
		);
	}
	console.log('many callers, outcome tally:', JSON.stringify(tally));

	// Every commit reported as committed is on the branch: none was overwritten.
	expect(committedOids.length).toBeGreaterThan(0);
	for (const oid of committedOids)
		await git(root, 'merge-base', '--is-ancestor', oid, 'HEAD');
	const parents = (await git(root, 'log', '--format=%P')).split('\n');
	expect(
		parents.every((line) => line.split(' ').filter(Boolean).length <= 1),
	).toBe(true);
	// The branch moved once per reported commit and never by force.
	expect(Number(await git(root, 'rev-list', '--count', 'HEAD'))).toBe(
		committedOids.length,
	);
	await git(root, 'fsck', '--strict', '--no-dangling');

	const last = await one.git.commit();
	expect(['committed', 'unchanged']).toContain(last.status);
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await git(root, 'diff', '--cached', '--quiet');
	await one.close();
	await two.close();
});

test('the subject and count describe the committed tree, not the files on disk', async () => {
	const { root, folder } = await directory('attempt-subject-', false);
	await writeFile(join(root, '.gitignore'), '*.log\n');
	await writeFile(join(root, 'a.md'), 'a');
	await writeFile(join(root, 'b.md'), 'b');
	await writeFile(join(root, 'debug.log'), 'ignored');
	const first = await folder.git.commit();
	const changed = async () =>
		(
			await git(
				root,
				'diff-tree',
				'--root',
				'-r',
				'--name-only',
				'--no-commit-id',
				'HEAD',
			)
		).split('\n');
	expect(await changed()).toEqual(['.gitignore', 'a.md', 'b.md']);
	expect(first).toMatchObject({
		status: 'committed',
		message: 'Update 3 files',
		changedPaths: 3,
	});
	expect(await git(root, 'log', '-1', '--format=%s')).toBe('Update 3 files');

	// Four files change on disk; one is ignored and one ends as it began.
	await writeFile(join(root, 'a.md'), 'a2');
	await writeFile(join(root, 'b.md'), 'b');
	await writeFile(join(root, 'debug.log'), 'still ignored');
	const second = await folder.git.commit();
	expect(await changed()).toEqual(['a.md']);
	expect(second).toMatchObject({
		status: 'committed',
		message: 'Update a.md',
		changedPaths: 1,
	});
	await folder.close();
});

test('close from a commit activity observer refuses unadmitted work or waits for the admitted attempt', async () => {
	const mine = await tab(freshEnvironment(), 'close-from-activity');
	const hold = gate();
	mine.probe.hold = hold;
	let initiated = false;
	let closed = false;
	let closing: Promise<void> | undefined;
	const unsubscribe = mine.history.subscribe((snapshot) => {
		if (initiated || !snapshot.activity.commit.active) return;
		initiated = true;
		closing = mine.history.close().then(() => {
			closed = true;
		});
	});
	try {
		await mine.save('note.md', 'saved');
		await until(() => closed || mine.probe.publications > 0);
		if (closed) {
			await Bun.sleep(20);
			expect(mine.probe.publications).toBe(0);
		} else {
			expect(mine.probe.publications).toBe(1);
			hold.open();
			await closing;
			expect(await mine.committed()).toEqual({ 'note.md': 'saved' });
		}
		expect(closed).toBe(true);
		expect(mine.probe.pushes).toBe(0);
	} finally {
		hold.open();
		unsubscribe();
		await closing;
		await mine.history.close();
		mine.db.close();
	}
});
