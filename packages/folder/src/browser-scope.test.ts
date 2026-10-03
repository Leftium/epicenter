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
	indexedDb: ReturnType<typeof environment>,
	scope?: BrowserFolderOptions['scope'],
) {
	const folder = expectOk(
		await openFolder({
			id,
			definition,
			browser: { indexedDb, scope, commitOnEdit: false },
		}),
	);
	folders.push(folder);
	return folder;
}

test('explicit release Local reopens legacy bytes and history at the established names', async () => {
	const storage = environment();
	const legacy = await open(storage);
	expectOk(await legacy.files.create('saved.txt', 'legacy'));
	expect((await legacy.git.commit()).status).toBe('committed');
	await legacy.close();
	const reopened = await open(storage, { channel: 'release' });
	expect(reopened.location).toEqual(legacy.location);
	expect(
		new TextDecoder().decode(
			expectOk(await reopened.files.read('saved.txt')).bytes,
		),
	).toBe('legacy');
	expect((await reopened.git.log(10)).data).toHaveLength(1);
	expect(new Set(storage.names).size).toBe(1);
});

test('channels and authority/principal pairs retain separate bytes and hints', async () => {
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
	expect(lockNames.size).toBe(scopes.length);
	expect(new Set(storage.names).size).toBe(scopes.length);
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

test('an unassigned legacy folder refuses a new scope without creating an empty replacement', async () => {
	const storage = environment();
	const legacy = await open(storage);
	expectOk(await legacy.files.create('saved.txt', 'retain me'));
	expect((await legacy.git.commit()).status).toBe('committed');
	const before = await storage.indexedDB.databases();
	const error = expectErr(
		await openFolder({
			id,
			definition,
			browser: { indexedDb: storage, scope: { channel: 'development' } },
		}),
	);
	expect(error.name).toBe('LegacyScopeUnassigned');
	expect(await storage.indexedDB.databases()).toEqual(before);
	expect(
		new TextDecoder().decode(
			expectOk(await legacy.files.read('saved.txt')).bytes,
		),
	).toBe('retain me');
	expect((await legacy.git.log(10)).data).toHaveLength(1);
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
				indexedDb: storage,
				scope: {
					channel: 'release',
					account: { authorityId: '', principalId: asPrincipalId('alice') },
				},
			},
		}),
	);
	expect(error.name).toBe('InvalidBrowserScope');
	expect(await storage.indexedDB.databases()).toEqual([]);
});

test('failed database enumeration refuses without creating storage', async () => {
	const storage = environment();
	const databases = storage.indexedDB.databases.bind(storage.indexedDB);
	storage.indexedDB.databases = async () => {
		throw new Error('Enumeration unavailable');
	};
	const error = expectErr(
		await openFolder({
			id,
			definition,
			browser: { indexedDb: storage, scope: { channel: 'development' } },
		}),
	);
	expect(error.name).toBe('Unavailable');
	expect(await databases()).toEqual([]);
});
