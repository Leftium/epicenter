/**
 * Moving a folder an earlier version saved in IndexedDB into the origin
 * private file system, through the production opener.
 *
 * The earlier version's database is seeded from a folder the opener made in
 * a scratch tree (`legacy.test-support.ts`), so it holds real Git history.
 * Crash states are built as fixtures: a cursor committed in the frozen
 * database beside the file a crash would leave, not only caught failures.
 *
 * Key behaviors:
 * - Files, empty directories, and history arrive exactly, under the same
 *   commit IDs; the four data stores stay unchanged as the backup
 * - The database is always frozen and read, so an earlier build's save made
 *   after a stale look is still copied
 * - An open earlier connection is closed by the freeze; one that does not let
 *   go refuses the copy; an earlier build cannot open the database again
 * - A resumed copy keeps what it copied and rewrites only the empty file its
 *   cursor names; any other empty, different, or unknown entry refuses the
 *   copy and stays as it was
 * - An empty ready marker is finished only under its cursor
 * - A database whose bytes do not match their records is refused, unchanged
 */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, type Folder, openFolder } from './browser.js';
import { MIGRATION_STORE } from './browser-migration.js';
import { browserStorage, opfsOf } from './browser-storage.test-support.js';
import {
	completion,
	type IndexedDbEnvironment,
	request,
	STORES,
} from './browser-store.js';
import {
	legacyContents,
	openLegacyDatabase,
	seedLegacyFolder,
} from './legacy.test-support.js';
import type { MemoryOpfs } from './opfs.test-support.js';
import { ensureDirectory } from './opfs-store.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();

const definition = defineFolder({ kv: {}, tables: {} });
const author = { name: 'Mover', email: 'mover@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
const ROOT = 'Epicenter/local/m';
const DATABASE = 'epicenter-folder:m';
const ADDRESS = JSON.stringify(['release', 'local', null, 'm']);
const MARKER = '.git/epicenter-folder.json';

let storage: IndexedDbEnvironment;
let opfs: MemoryOpfs;
const opened: Folder<typeof definition>[] = [];

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

function fresh() {
	storage = { indexedDB: new IDBFactory(), IDBKeyRange };
	opfs = opfsOf(storage);
}

/**
 * Seed `database` with a folder as an earlier version kept it: committed
 * files, an uncommitted one, and an empty directory. Returns its history.
 */
async function seedLegacy(database = DATABASE) {
	const scratch = { indexedDB: new IDBFactory(), IDBKeyRange };
	const folder = expectOk(
		await openFolder({
			id: 'm',
			definition,
			browser: { author, commitOnEdit: false, ...browserStorage(scratch) },
		}),
	);
	expectOk(await folder.files.create('notes/a.md', '# A\n'));
	expectOk(await folder.files.create('bytes.bin', allBytes));
	expectOk(await folder.files.create('empty.txt', ''));
	expectOk(await folder.files.mkdir('drafts/empty'));
	const commit = await folder.git.commit();
	if (commit.status !== 'committed') throw new Error(commit.status);
	expectOk(await folder.files.create('uncommitted.md', 'later\n'));
	const log = expectOk(await folder.git.log(10)).map((entry) => entry.oid);
	await folder.close();
	await seedLegacyFolder(
		storage,
		database,
		legacyContents(opfsOf(scratch), ROOT),
	);
	return { log };
}

async function openOpfs(scope?: { channel: 'release' | 'development' }) {
	return openFolder({
		id: 'm',
		definition,
		browser: { author, commitOnEdit: false, scope, ...browserStorage(storage) },
	});
}

async function openRaw(name = DATABASE) {
	return request(storage.indexedDB.open(name));
}

/** The database's version and every store's keys and hashed values. */
async function rawDatabase(name = DATABASE) {
	const db = await openRaw(name);
	const stores: Record<string, Record<string, string>> = {};
	for (const store of db.objectStoreNames) {
		const tx = db.transaction(store);
		const keys = (await request(
			tx.objectStore(store).getAllKeys(),
		)) as string[];
		const values = await request(tx.objectStore(store).getAll());
		stores[store] = Object.fromEntries(
			keys.map((key, index) => {
				const value = values[index];
				return [
					key,
					value instanceof Uint8Array
						? createHash('sha256').update(value).digest('hex')
						: JSON.stringify(value),
				];
			}),
		);
	}
	const version = db.version;
	db.close();
	return { version, stores };
}

/** The four data stores only: what must never change. */
const payload = (dump: Awaited<ReturnType<typeof rawDatabase>>) =>
	Object.fromEntries(
		Object.values(STORES).map((store) => [store, dump.stores[store]]),
	);

/** Commit a cursor into the frozen database, as a crash would leave it. */
async function setCursor(path: string, address = ADDRESS) {
	const db = await openRaw();
	const tx = db.transaction(MIGRATION_STORE, 'readwrite');
	const done = completion(tx);
	tx.objectStore(MIGRATION_STORE).put(
		{ address, path, phase: 'creating' },
		'cursor',
	);
	await done;
	db.close();
}

const folderFiles = () =>
	[...opfs.files(ROOT).keys()]
		.filter((path) => !path.startsWith('.git/'))
		.sort();

/** Freeze and partly copy: the first attempt stops at `uncommitted.md`. */
async function interruptedCopy() {
	opfs.faults.write = (path) =>
		path.endsWith(`${ROOT}/uncommitted.md`) ? 'fail' : undefined;
	expect(expectErr(await openOpfs()).name).toBe('LegacyMigration');
	opfs.faults.write = undefined;
}

test('files, empty directories, and history arrive exactly; the data stores stay unchanged', async () => {
	fresh();
	const { log } = await seedLegacy();
	const before = await rawDatabase();

	const folder = expectOk(await openOpfs());
	opened.push(folder);
	expect(folder.location).toEqual({ kind: 'opfs', directory: ROOT });
	expect(expectOk(await folder.files.read('bytes.bin')).bytes).toEqual(
		allBytes,
	);
	expect(expectOk(await folder.files.read('empty.txt')).bytes).toEqual(
		new Uint8Array(),
	);
	const listing = expectOk(await folder.files.list());
	expect(listing.files.map((file) => file.path)).toEqual([
		'bytes.bin',
		'empty.txt',
		'notes/a.md',
		'uncommitted.md',
	]);
	expect(listing.directories).toEqual(['drafts', 'drafts/empty', 'notes']);
	expect(expectOk(await folder.git.log(10)).map((entry) => entry.oid)).toEqual(
		log,
	);
	expect(
		expectOk(await folder.git.status()).changes.map((change) => change.path),
	).toEqual(['uncommitted.md']);
	expect(JSON.parse(decoder.decode(opfs.files(ROOT).get(MARKER)))).toEqual({
		address: ADDRESS,
		migratedFrom: { database: DATABASE, version: 1 },
	});

	const after = await rawDatabase();
	expect(after.version).toBe(2);
	expect(payload(after)).toEqual(payload(before));
	// The freeze record stays; the cursor is gone once the copy finished.
	expect(Object.keys(after.stores[MIGRATION_STORE]!)).toEqual(['frozen']);
	// An earlier build cannot open the database again.
	await expect(openLegacyDatabase(storage, DATABASE)).rejects.toMatchObject({
		name: 'VersionError',
	});

	// Later opens use the directory alone.
	await folder.close();
	opened.length = 0;
	opfs.faults.close = () => 'fail';
	const again = expectOk(await openOpfs());
	opened.push(again);
	opfs.faults.close = undefined;
	expect(expectOk(await again.git.log(10)).map((entry) => entry.oid)).toEqual(
		log,
	);
});

test('a save an earlier build made after a stale look is still copied', async () => {
	fresh();
	// Enumeration answers from before an earlier build created the database.
	storage.indexedDB.databases = async () => [];
	await seedLegacy();
	const folder = expectOk(await openOpfs());
	opened.push(folder);
	expect(
		decoder.decode(expectOk(await folder.files.read('uncommitted.md')).bytes),
	).toBe('later\n');
	expect(expectOk(await folder.git.log(10))).toHaveLength(1);
});

test('an earlier connection still open is closed by the freeze, and its later save lands nowhere', async () => {
	fresh();
	await seedLegacy();
	const before = await rawDatabase();
	const earlier = await openLegacyDatabase(storage, DATABASE);
	earlier.onversionchange = () => earlier.close();
	const folder = expectOk(await openOpfs());
	opened.push(folder);
	expect(() =>
		earlier
			.transaction(STORES.contents, 'readwrite')
			.objectStore(STORES.contents)
			.put(encoder.encode('late'), 'late.md'),
	).toThrow();
	expect(opfs.files(ROOT).has('late.md')).toBe(false);
	expect(payload(await rawDatabase())).toEqual(payload(before));
});

test('a connection that does not let go refuses the copy; after it closes the copy runs', async () => {
	fresh();
	await seedLegacy();
	const holder = await openLegacyDatabase(storage, DATABASE);
	const refused = expectErr(await openOpfs());
	expect(refused).toMatchObject({ name: 'LegacyInUse', database: DATABASE });
	expect(opfs.files(ROOT).has(MARKER)).toBe(false);
	holder.close();
	const folder = expectOk(await openOpfs());
	opened.push(folder);
	expect(expectOk(await folder.files.read('bytes.bin')).bytes).toEqual(
		allBytes,
	);
});

test('a resumed copy keeps what it copied and finishes from the same frozen snapshot', async () => {
	fresh();
	const { log } = await seedLegacy();
	await interruptedCopy();
	expect(opfs.files(ROOT).get('bytes.bin')).toEqual(allBytes);
	expect(opfs.files(ROOT).has(MARKER)).toBe(false);
	const folder = expectOk(await openOpfs());
	opened.push(folder);
	expect(folderFiles()).toEqual([
		'bytes.bin',
		'empty.txt',
		'notes/a.md',
		'uncommitted.md',
	]);
	expect(expectOk(await folder.git.log(10)).map((entry) => entry.oid)).toEqual(
		log,
	);
	expect(Object.keys((await rawDatabase()).stores[MIGRATION_STORE]!)).toEqual([
		'frozen',
	]);
});

/**
 * Seed a folder as earlier builds often recorded it: a nested file with no
 * directory records, and a deep empty directory with no record for its
 * parent. Returns its history.
 */
async function seedOldSchema() {
	const scratch = { indexedDB: new IDBFactory(), IDBKeyRange };
	const folder = expectOk(
		await openFolder({
			id: 'm',
			definition,
			browser: { author, commitOnEdit: false, ...browserStorage(scratch) },
		}),
	);
	expectOk(await folder.files.create('deep/nested/file.md', 'nested\n'));
	expectOk(await folder.files.create('bytes.bin', allBytes));
	expectOk(await folder.files.mkdir('kept/empty'));
	const commit = await folder.git.commit();
	if (commit.status !== 'committed') throw new Error(commit.status);
	const log = expectOk(await folder.git.log(10)).map((entry) => entry.oid);
	await folder.close();
	const contents = legacyContents(opfsOf(scratch), ROOT);
	// Only the deepest directory is recorded; `kept` and `deep` are not.
	await seedLegacyFolder(storage, DATABASE, {
		...contents,
		directories: ['kept/empty'],
	});
	return { log };
}

async function expectOldSchemaCopied(log: string[]) {
	const folder = expectOk(await openOpfs());
	opened.push(folder);
	const listing = expectOk(await folder.files.list());
	expect(listing.files.map((file) => file.path)).toEqual([
		'bytes.bin',
		'deep/nested/file.md',
	]);
	expect(listing.directories).toEqual([
		'deep',
		'deep/nested',
		'kept',
		'kept/empty',
	]);
	expect(expectOk(await folder.files.read('bytes.bin')).bytes).toEqual(
		allBytes,
	);
	expect(
		decoder.decode(
			expectOk(await folder.files.read('deep/nested/file.md')).bytes,
		),
	).toBe('nested\n');
	expect(expectOk(await folder.git.log(10)).map((entry) => entry.oid)).toEqual(
		log,
	);
	expect(expectOk(await folder.git.status()).changes).toEqual([]);
}

test('directories above recorded directories and files are the folder’s, though earlier builds did not record them', async () => {
	fresh();
	const { log } = await seedOldSchema();
	const before = await rawDatabase();
	await expectOldSchemaCopied(log);
	expect(payload(await rawDatabase())).toEqual(payload(before));
});

test('a resumed copy of such a folder keeps its hierarchy, bytes, and history; an empty directory no record explains still refuses', async () => {
	fresh();
	const { log } = await seedOldSchema();
	opfs.faults.write = (path) =>
		path.endsWith(`${ROOT}/deep/nested/file.md`) ? 'fail' : undefined;
	expect(expectErr(await openOpfs()).name).toBe('LegacyMigration');
	opfs.faults.write = undefined;
	expect(opfs.files(ROOT).has(MARKER)).toBe(false);
	await expectOldSchemaCopied(log);
	for (const folder of opened.splice(0)) await folder.close();

	fresh();
	await seedOldSchema();
	opfs.faults.write = (path) =>
		path.endsWith(`${ROOT}/deep/nested/file.md`) ? 'fail' : undefined;
	expect(expectErr(await openOpfs()).name).toBe('LegacyMigration');
	opfs.faults.write = undefined;
	// A child of a directory the database implies, which it does not have.
	expectOk(
		await ensureDirectory(await opfs.getDirectory(), `${ROOT}/kept/foreign`),
	);
	const refused = expectErr(await openOpfs());
	expect(refused.name).toBe('LegacyMigration');
	expect(refused.message).toContain('kept/foreign/');
	expect(opfs.directories(ROOT)).toContain('kept/foreign');
	expect(opfs.files(ROOT).has(MARKER)).toBe(false);
});

test('crash fixtures: only the empty file the cursor names is rewritten', async () => {
	// A crash after the file was created and before its stream closed.
	fresh();
	await seedLegacy();
	await interruptedCopy();
	await setCursor('uncommitted.md');
	opfs.put(`${ROOT}/uncommitted.md`, new Uint8Array());
	const finished = expectOk(await openOpfs());
	opened.push(finished);
	expect(
		decoder.decode(expectOk(await finished.files.read('uncommitted.md')).bytes),
	).toBe('later\n');

	// The same empty file without the cursor is someone else's.
	fresh();
	await seedLegacy();
	await interruptedCopy();
	await setCursor('notes/a.md');
	opfs.put(`${ROOT}/uncommitted.md`, new Uint8Array());
	const empty = expectErr(await openOpfs());
	expect(empty.name).toBe('LegacyMigration');
	expect(empty.message).toContain(
		"'uncommitted.md' already holds something other",
	);
	expect(opfs.files(ROOT).get('uncommitted.md')).toEqual(new Uint8Array());

	// A nonempty file the cursor names is a third state.
	fresh();
	await seedLegacy();
	await interruptedCopy();
	await setCursor('uncommitted.md');
	opfs.put(`${ROOT}/uncommitted.md`, encoder.encode('someone else'));
	const third = expectErr(await openOpfs());
	expect(third.name).toBe('LegacyMigration');
	expect(decoder.decode(opfs.files(ROOT).get('uncommitted.md'))).toBe(
		'someone else',
	);

	// A private file the cursor names is finished the same way: the copy
	// stopped while creating `.git/HEAD`, leaving it empty.
	fresh();
	await seedLegacy();
	opfs.faults.write = (path) =>
		path.endsWith(`${ROOT}/.git/HEAD`) ? 'fail' : undefined;
	expect(expectErr(await openOpfs()).name).toBe('LegacyMigration');
	opfs.faults.write = undefined;
	expect((await rawDatabase()).stores[MIGRATION_STORE]!.cursor).toContain(
		'.git/HEAD',
	);
	opfs.put(`${ROOT}/.git/HEAD`, new Uint8Array());
	const head = expectOk(await openOpfs());
	opened.push(head);
	expect(decoder.decode(opfs.files(ROOT).get('.git/HEAD'))).toBe(
		'ref: refs/heads/main\n',
	);
});

test('crash fixtures: an empty ready marker is finished only under its cursor', async () => {
	fresh();
	const { log } = await seedLegacy();
	await interruptedCopy();
	expectOk(await openOpfs()).close();
	// The marker's creation never published.
	opfs.put(`${ROOT}/${MARKER}`, new Uint8Array());
	await setCursor(MARKER);
	const folder = expectOk(await openOpfs());
	opened.push(folder);
	expect(expectOk(await folder.git.log(10)).map((entry) => entry.oid)).toEqual(
		log,
	);
	expect(JSON.parse(decoder.decode(opfs.files(ROOT).get(MARKER))).address).toBe(
		ADDRESS,
	);

	// Without the cursor, an empty marker is refused and left alone.
	await folder.close();
	opened.length = 0;
	opfs.put(`${ROOT}/${MARKER}`, new Uint8Array());
	const refused = expectErr(await openOpfs());
	expect(refused.name).toBe('LegacyMigration');
	expect(opfs.files(ROOT).get(MARKER)).toEqual(new Uint8Array());
});

test('a cursor for another address refuses the copy', async () => {
	fresh();
	await seedLegacy();
	await interruptedCopy();
	await setCursor('uncommitted.md', '["elsewhere"]');
	const refused = expectErr(await openOpfs());
	expect(refused.name).toBe('LegacyMigration');
	expect(refused.message).toContain('["elsewhere"]');
});

test('different bytes, or an entry the database does not have, refuse the copy and stay', async () => {
	fresh();
	await seedLegacy();
	opfs.put(`${ROOT}/uncommitted.md`, encoder.encode('theirs\n'));
	opfs.put(`${ROOT}/stray/unknown.txt`, encoder.encode('unknown'));
	const different = expectErr(await openOpfs());
	expect(different.name).toBe('LegacyMigration');
	expect(decoder.decode(opfs.files(ROOT).get('uncommitted.md'))).toBe(
		'theirs\n',
	);
	opfs.drop(`${ROOT}/uncommitted.md`);
	const unknown = expectErr(await openOpfs());
	expect(unknown.message).toContain('stray/unknown.txt');
	expect(decoder.decode(opfs.files(ROOT).get('stray/unknown.txt'))).toBe(
		'unknown',
	);
	expect(opfs.files(ROOT).has(MARKER)).toBe(false);
	expect(
		Object.keys((await rawDatabase()).stores[STORES.inventory]!),
	).toContain('uncommitted.md');
});

test('a directory marked for another address, or holding entries no copy explains, is not opened', async () => {
	fresh();
	opfs.put(
		`${ROOT}/${MARKER}`,
		encoder.encode(JSON.stringify({ address: '["elsewhere"]' })),
	);
	const marked = expectErr(await openOpfs());
	expect(marked.name).toBe('Unavailable');
	expect(marked.message).toContain('["elsewhere"]');

	fresh();
	opfs.put(`${ROOT}/found.txt`, encoder.encode('found'));
	const unexplained = expectErr(await openOpfs());
	expect(unexplained.name).toBe('LegacyMigration');
	expect(unexplained.message).toContain('found.txt');
	expect(decoder.decode(opfs.files(ROOT).get('found.txt'))).toBe('found');
});

test('bytes that do not match their recorded SHA-256 refuse the copy and change nothing', async () => {
	fresh();
	await seedLegacy();
	const db = await openLegacyDatabase(storage, DATABASE);
	const tx = db.transaction(STORES.contents, 'readwrite');
	const done = completion(tx);
	tx.objectStore(STORES.contents).put(encoder.encode('# B\n'), 'notes/a.md');
	await done;
	db.close();
	const before = await rawDatabase();
	const refused = expectErr(await openOpfs());
	expect(refused.name).toBe('LegacyMigration');
	expect(refused.message).toContain('notes/a.md');
	expect(payload(await rawDatabase())).toEqual(payload(before));
	expect(opfs.files(ROOT).has(MARKER)).toBe(false);
});

test('a scoped folder copies only its own scope’s database', async () => {
	fresh();
	const scoped = JSON.stringify(['development', 'local', null, 'm']);
	await seedLegacy(`epicenter-folder-scoped:${scoped}`);
	const folder = expectOk(await openOpfs({ channel: 'development' }));
	opened.push(folder);
	expect(folder.location).toEqual({
		kind: 'opfs',
		directory: 'Epicenter Dev/local/m',
	});
	expect(expectOk(await folder.files.read('bytes.bin')).bytes).toEqual(
		allBytes,
	);
	const local = expectOk(await openOpfs());
	opened.push(local);
	expect(expectOk(await local.files.list()).files).toEqual([]);
});

test('a new folder freezes its would-be database so an earlier build cannot start one beside it', async () => {
	fresh();
	const folder = expectOk(await openOpfs());
	opened.push(folder);
	expectOk(await folder.files.create('new.md', 'new'));
	await expect(openLegacyDatabase(storage, DATABASE)).rejects.toMatchObject({
		name: 'VersionError',
	});
	const frozen = await rawDatabase();
	expect(frozen.version).toBe(2);
	expect(JSON.parse(decoder.decode(opfs.files(ROOT).get(MARKER)))).toEqual({
		address: ADDRESS,
		migratedFrom: null,
	});
});
