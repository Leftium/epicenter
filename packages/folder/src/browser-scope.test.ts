/**
 * Browser folder scopes: one captured address per channel, owner, and folder
 * ID, each its own OPFS directory, Web Locks, and hint channel.
 *
 * Key behaviors:
 * - Omitted scope and explicit release Local are one folder
 * - Channels and authority/principal pairs keep separate bytes, locks, and hints
 * - A scoped folder with nothing of its own starts only once the Local
 *   database of its ID is frozen and holds nothing, or this version's Local
 *   folder is ready: an earlier build's Local folder is never given to it
 * - The account is captured before hashing, and invalid identities refuse
 *   before anything is created
 */
import { afterEach, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type BrowserFolderOptions,
	defineFolder,
	type Folder,
	openFolder,
} from './browser.js';
import { browserStorage, opfsOf } from './browser-storage.test-support.js';
import { STORES } from './browser-store.js';
import { hashBytes } from './capture.js';
import {
	legacyContents,
	openLegacyDatabase,
	seedLegacyFolder,
} from './legacy.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();
const id = 'so.epicenter.scopetest';
const definition = defineFolder({
	kv: {},
	tables: {},
});
const folders: Folder<typeof definition>[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0)) await folder.close();
});

function environment() {
	const names: string[] = [];
	class ObservedChannel extends BroadcastChannel {
		constructor(name: string) {
			super(name);
			names.push(name);
		}
	}
	return {
		indexedDB: new IDBFactory(),
		IDBKeyRange,
		BroadcastChannel: ObservedChannel,
		names,
	};
}

async function open(
	storage: ReturnType<typeof environment>,
	scope?: BrowserFolderOptions['scope'],
) {
	const folder = expectOk(
		await openFolder({
			id,
			definition,
			browser: { ...browserStorage(storage), scope, commitOnEdit: false },
		}),
	);
	folders.push(folder);
	return folder;
}

test('omitted scope and explicit release Local are one folder, with one hint channel', async () => {
	const storage = environment();
	const first = await open(storage);
	expectOk(await first.files.create('saved.txt', 'local'));
	expect((await first.git.commit()).status).toBe('committed');
	await first.close();
	const reopened = await open(storage, { channel: 'release' });
	expect(reopened.location).toEqual(first.location);
	expect(reopened.location).toEqual({
		kind: 'opfs',
		directory: `Epicenter/local/${id}`,
	});
	expect(
		new TextDecoder().decode(
			expectOk(await reopened.files.read('saved.txt')).bytes,
		),
	).toBe('local');
	expect((await reopened.git.log(10)).data).toHaveLength(1);
	expect(new Set(storage.names).size).toBe(1);
});

test('channels and authority/principal pairs retain separate bytes, locks, and hints', async () => {
	const storage = environment();
	const lockNames = new Set<string>();
	const request = navigator.locks.request;
	navigator.locks.request = new Proxy(request, {
		apply(target, receiver, args) {
			lockNames.add(args[0]);
			return Reflect.apply(target, receiver, args);
		},
	});
	const alice = asPrincipalId('alice');
	const scopes: BrowserFolderOptions['scope'][] = [
		{
			channel: 'release',
			account: { authorityId: 'https://one.example', principalId: alice },
		},
		{
			channel: 'development',
			account: { authorityId: 'https://one.example', principalId: alice },
		},
		{
			channel: 'release',
			account: { authorityId: 'https://two.example', principalId: alice },
		},
		{
			channel: 'release',
			account: {
				authorityId: 'https://one.example',
				principalId: asPrincipalId('bob'),
			},
		},
		{ channel: 'development' },
		{ channel: 'release' },
	];
	try {
		for (const [index, scope] of scopes.entries()) {
			const folder = await open(storage, scope);
			expectOk(await folder.files.create('saved.txt', String(index)));
			expect((await folder.git.commit()).status).toBe('committed');
		}
	} finally {
		navigator.locks.request = request;
	}
	// Each scope has its own open, files, and Git locks.
	expect(lockNames.size).toBe(scopes.length * 3);
	expect(new Set(storage.names).size).toBe(scopes.length);
	expect(
		new Set(folders.map((folder) => JSON.stringify(folder.location))).size,
	).toBe(scopes.length);
	for (const [index, scope] of scopes.entries()) {
		const folder = await open(storage, scope);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('saved.txt')).bytes,
			),
		).toBe(String(index));
	}
	// A peer hears a save in its own scope; the other account does not hear it.
	const peer = folders[scopes.length]!;
	let crossed = false;
	folders[2]!.onFilesChanged(() => {
		crossed = true;
	});
	const heard = new Promise<void>((resolve) =>
		peer.onFilesChanged(() => resolve()),
	);
	expectOk(await folders[0]!.files.create('new.txt', 'new'));
	await heard;
	expect(crossed).toBe(false);
});

test("a scoped folder refuses to start beside an earlier version's unclaimed Local folder, freezing it and creating no folder", async () => {
	// An earlier version's Local folder, never opened by this version.
	const scratch = { indexedDB: new IDBFactory(), IDBKeyRange };
	const made = expectOk(
		await openFolder({
			id,
			definition,
			browser: { ...browserStorage(scratch), commitOnEdit: false },
		}),
	);
	expectOk(await made.files.create('saved.txt', 'retain me'));
	expect((await made.git.commit()).status).toBe('committed');
	await made.close();
	const storage = environment();
	await seedLegacyFolder(
		storage,
		`epicenter-folder:${id}`,
		legacyContents(opfsOf(scratch), `Epicenter/local/${id}`),
	);
	expect(await openScoped(storage)).toMatchObject({
		name: 'LegacyScopeUnassigned',
		database: LOCAL,
	});
	// Frozen: the earlier build can no longer write it; nothing else changed.
	expect(await earlierBuildOpens(storage)).toBe('VersionError');
	expect(opfsOf(storage).directories()).toEqual([]);
	// Release Local claims it; then the scope starts on its own.
	const local = await open(storage);
	expect(
		new TextDecoder().decode(
			expectOk(await local.files.read('saved.txt')).bytes,
		),
	).toBe('retain me');
	const development = await open(storage, { channel: 'development' });
	expect(expectOk(await development.files.list()).files).toEqual([]);
});

test('account identity is captured before async hashing and remains fixed', async () => {
	const storage = environment();
	const account = {
		authorityId: 'https://one.example',
		principalId: asPrincipalId('alice'),
	};
	const opening = open(storage, { channel: 'release', account });
	account.authorityId = 'https://two.example';
	const captured = await opening;
	expectOk(await captured.files.create('saved.txt', 'first account'));
	const original = await open(storage, {
		channel: 'release',
		account: {
			authorityId: 'https://one.example',
			principalId: asPrincipalId('alice'),
		},
	});
	expect(original.location).toEqual(captured.location);
	expect(
		new TextDecoder().decode(
			expectOk(await original.files.read('saved.txt')).bytes,
		),
	).toBe('first account');
});

test('invalid account identity refuses before creating storage', async () => {
	const storage = environment();
	const error = expectErr(
		await openFolder({
			id,
			definition,
			browser: {
				...browserStorage(storage),
				scope: {
					channel: 'release',
					account: { authorityId: '', principalId: asPrincipalId('alice') },
				},
			},
		}),
	);
	expect(error.name).toBe('InvalidBrowserScope');
	expect(await storage.indexedDB.databases()).toEqual([]);
	expect(opfsOf(storage).directories()).toEqual([]);
});

const LOCAL = `epicenter-folder:${id}`;
const encoder = new TextEncoder();

/** Open the development scope of `id`: its result's error, or `undefined`. */
async function openScoped(storage: ReturnType<typeof environment>) {
	const opened = await openFolder({
		id,
		definition,
		browser: {
			...browserStorage(storage),
			scope: { channel: 'development' },
			commitOnEdit: false,
		},
	});
	if (opened.data) folders.push(opened.data);
	return opened.error ?? undefined;
}

/** How an earlier build's open of the Local database ends: 'opened' or the error's name. */
async function earlierBuildOpens(storage: ReturnType<typeof environment>) {
	try {
		const db = await openLegacyDatabase(storage, LOCAL);
		db.close();
		return 'opened';
	} catch (cause) {
		return (cause as Error).name;
	}
}

/** One file as an earlier build saved it, for `seedLegacyFolder`. */
const oneFile = (text: string) => ({
	files: new Map([['saved.txt', encoder.encode(text)]]),
	directories: [],
	git: new Map<string, Uint8Array>(),
});

test('with no Local database, a scoped folder starts and freezes an empty one, so an earlier build cannot start Local beside it', async () => {
	const storage = environment();
	expect(await openScoped(storage)).toBeUndefined();
	expect(await earlierBuildOpens(storage)).toBe('VersionError');
	// This version's Local open copies the empty frozen database.
	const local = await open(storage);
	expect(expectOk(await local.files.list()).files).toEqual([]);
});

test('an empty Local database an earlier build opened does not hold a scoped folder back', async () => {
	const storage = environment();
	(await openLegacyDatabase(storage, LOCAL)).close();
	expect(await openScoped(storage)).toBeUndefined();
	expect(await earlierBuildOpens(storage)).toBe('VersionError');
});

test("an earlier build's save that lands as the scoped folder fences Local is what decides: the scope is refused and the save is kept", async () => {
	const storage = environment();
	const bytes = encoder.encode('saved by an earlier tab');
	const sha256 = await hashBytes(bytes);
	const openDatabase = storage.indexedDB.open.bind(storage.indexedDB);
	let raced = false;
	storage.indexedDB.open = (name: string, version?: number) => {
		if (name === LOCAL && version === 2 && !raced) {
			// The earlier tab opens and saves just before the fence's freeze;
			// like earlier builds, it lets go on versionchange.
			raced = true;
			const earlier = openDatabase(name, 1);
			earlier.onupgradeneeded = () => {
				for (const store of Object.values(STORES))
					earlier.result.createObjectStore(store);
			};
			earlier.onsuccess = () => {
				const db = earlier.result;
				db.onversionchange = () => db.close();
				const tx = db.transaction(
					[STORES.inventory, STORES.contents],
					'readwrite',
				);
				tx.objectStore(STORES.inventory).put(
					{ sha256, size: bytes.byteLength, mtimeMs: 1, ino: 1 },
					'saved.txt',
				);
				tx.objectStore(STORES.contents).put(bytes, 'saved.txt');
			};
		}
		return openDatabase(name, version);
	};
	expect(await openScoped(storage)).toMatchObject({
		name: 'LegacyScopeUnassigned',
	});
	expect(raced).toBe(true);
	expect(await earlierBuildOpens(storage)).toBe('VersionError');
	const local = await open(storage);
	expect(
		new TextDecoder().decode(
			expectOk(await local.files.read('saved.txt')).bytes,
		),
	).toBe('saved by an earlier tab');
});

test('a Local database frozen by an open whose copy did not finish is still unclaimed', async () => {
	const storage = environment();
	await seedLegacyFolder(storage, LOCAL, oneFile('retain me'));
	const tree = opfsOf(storage);
	tree.faults.write = (path) =>
		path.endsWith('/saved.txt') ? 'fail' : undefined;
	const failed = await openFolder({
		id,
		definition,
		browser: { ...browserStorage(storage), commitOnEdit: false },
	});
	expect(failed.error?.name).toBe('LegacyMigration');
	tree.faults.write = undefined;
	// Frozen, but with no ready Local folder: not proof of a claim.
	expect(await earlierBuildOpens(storage)).toBe('VersionError');
	expect(await openScoped(storage)).toMatchObject({
		name: 'LegacyScopeUnassigned',
	});
	const local = await open(storage);
	expect(
		new TextDecoder().decode(
			expectOk(await local.files.read('saved.txt')).bytes,
		),
	).toBe('retain me');
	expect(await openScoped(storage)).toBeUndefined();
});

test('an earlier Local tab that does not let go refuses the scope as in use, and no folder is made', async () => {
	const storage = environment();
	const held = await openLegacyDatabase(storage, LOCAL);
	try {
		expect(await openScoped(storage)).toMatchObject({
			name: 'LegacyInUse',
			database: LOCAL,
		});
		expect(opfsOf(storage).directories()).toEqual([]);
	} finally {
		held.close();
	}
});

test('a scoped folder an earlier version saved is copied whatever Local holds, and Local is left as it was', async () => {
	const storage = environment();
	await seedLegacyFolder(storage, LOCAL, oneFile('local'));
	await seedLegacyFolder(
		storage,
		`epicenter-folder-scoped:${JSON.stringify(['development', 'local', null, id])}`,
		oneFile('scoped'),
	);
	expect(await openScoped(storage)).toBeUndefined();
	const scoped = folders.at(-1)!;
	expect(
		new TextDecoder().decode(
			expectOk(await scoped.files.read('saved.txt')).bytes,
		),
	).toBe('scoped');
	// Local was not touched: an earlier build still opens it.
	expect(await earlierBuildOpens(storage)).toBe('opened');
});

test('a Local fence that cannot open its database reports migration failure without claiming Local data exists', async () => {
	const storage = environment();
	const originalOpen = storage.indexedDB.open.bind(storage.indexedDB);
	const cause = new DOMException(
		'The database could not be created.',
		'QuotaExceededError',
	);
	storage.indexedDB.open = (name, version) => {
		if (name === `epicenter-folder:${id}`) throw cause;
		return originalOpen(name, version);
	};
	const refused = expectErr(
		await openFolder({
			id,
			definition,
			browser: {
				...browserStorage(storage),
				scope: { channel: 'development' },
				commitOnEdit: false,
			},
		}),
	);
	expect(refused.name).toBe('LegacyMigration');
	if (refused.name === 'LegacyMigration') {
		expect(refused.database).toBe(`epicenter-folder:${id}`);
		expect(refused.cause).toBe(cause);
	}
	expect(opfsOf(storage).directories()).not.toContain(
		`Epicenter Dev/local/${id}`,
	);
});
