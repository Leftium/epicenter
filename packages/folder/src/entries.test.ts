/**
 * Entry Point Tests
 *
 * The package has one automatic opener and two explicit ones, and all three
 * must be the same contract. These tests pin what each entry does when it is
 * merely imported, when it is asked to open where it cannot, and which
 * adapter the automatic entry chooses.
 *
 * Key behaviors:
 * - Importing any entry opens nothing and touches no global
 * - Every entry exports the same names besides its opener
 * - The automatic entry asks whether this is the desktop app when it is
 *   called, not when it is imported, and loads only the adapter it chose
 * - On a server, or anywhere without IndexedDB, opening is a returned refusal
 * - The browser entry refuses inside the desktop app, even with storage
 *   handed to it; the desktop entry refuses outside it; neither falls back
 * - A browser folder has a local author by default and needs an explicit one
 *   to use a remote
 * - Handles that share browser storage hear each other's saves
 *
 * See also:
 * - `folder.test-d.ts` for the same parity at the type level
 * - `evidence/bundles/bundles.test.ts` for what a build emits per entry
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';

let inShell = false;
const invoked: string[] = [];
const listened: string[] = [];
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(cmd: string) {
		invoked.push(cmd);
		// What Tauri answers when the shell never installed the plugin.
		throw 'plugin epicenter-folder not found';
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	async listen(name: string) {
		listened.push(name);
		return () => {};
	},
}));

const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
const bufferBefore = (globalThis as { Buffer?: unknown }).Buffer;
const root = await import('./index.js');
const browser = await import('./browser.js');
const tauri = await import('./tauri.js');
const bun = await import('./bun.js');
const contract = await import('./contract.js');

const definition = root.defineFolder({
	id: 'so.epicenter.entriestest',
	kv: {},
	tables: {
		notes: root.defineTable({ fields: { title: root.field.string() } }),
	},
});
const author = { name: 'Entries', email: 'entries@example.test' };

afterEach(() => {
	inShell = false;
	invoked.length = 0;
	listened.length = 0;
});

test('importing every entry opens nothing and adds no global', () => {
	expect(invoked).toEqual([]);
	expect(listened).toEqual([]);
	expect(
		Object.getOwnPropertyNames(globalThis).filter(
			(name) => !globalsBefore.has(name),
		),
	).toEqual([]);
	expect((globalThis as { Buffer?: unknown }).Buffer).toBe(bufferBefore);
	// This process has no IndexedDB, as a server render has none.
	expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
});

test('every entry exports the same contract beside its opener', () => {
	const names = (entry: object) =>
		Object.keys(entry)
			.filter((name) => name !== 'openFolder')
			.sort();
	const shared = names(contract);
	expect(shared).toContain('defineFolder');
	expect(shared).toContain('FileError');
	expect(names(root)).toEqual(shared);
	expect(names(browser)).toEqual(shared);
	expect(names(tauri)).toEqual(shared);
	// The directory entry adds its own tools to the same contract.
	expect(names(bun)).toEqual(expect.arrayContaining(shared));
	for (const entry of [root, browser, tauri, bun]) {
		expect(typeof entry.openFolder).toBe('function');
		for (const name of shared)
			expect((entry as Record<string, unknown>)[name]).toBe(
				(contract as Record<string, unknown>)[name],
			);
	}
	// One opener per entry: they are different functions with one signature.
	expect(
		new Set([root, browser, tauri, bun].map((e) => e.openFolder)).size,
	).toBe(4);
});

test('on a server the automatic entry refuses, and so does each explicit entry', async () => {
	expect(expectErr(await root.openFolder({ definition })).name).toBe(
		'NoIndexedDb',
	);
	expect(expectErr(await browser.openFolder({ definition })).name).toBe(
		'NoIndexedDb',
	);
	expect(expectErr(await tauri.openFolder({ definition })).name).toBe(
		'NotTauri',
	);
	expect(invoked).toEqual([]);
	expect(listened).toEqual([]);
});

test('the automatic entry decides when it is called: the desktop adapter in the shell, and no browser storage when that fails', async () => {
	const indexedDB = new IDBFactory();
	const options = {
		definition,
		browser: { author, indexedDb: { indexedDB, IDBKeyRange } },
	};

	// The same imported function, first outside the shell, then inside it.
	const inBrowser = expectOk(await root.openFolder(options));
	expect(inBrowser.location).toEqual({
		kind: 'indexedDb',
		database: 'epicenter-folder:so.epicenter.entriestest',
	});
	await inBrowser.close();
	expect(invoked).toEqual([]);
	const databases = await indexedDB.databases();
	expect(databases).toHaveLength(1);

	inShell = true;
	const other = new IDBFactory();
	const refused = expectErr(
		await root.openFolder({
			definition,
			id: 'another.folder',
			browser: { author, indexedDb: { indexedDB: other, IDBKeyRange } },
		}),
	);
	// The shell has no plugin. That is reported; it is not papered over with
	// an IndexedDB folder in another place.
	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('plugin epicenter-folder not found');
	expect(invoked).toEqual(['plugin:epicenter-folder|attach']);
	expect(await other.databases()).toEqual([]);
});

test('the browser entry refuses inside the desktop app even when handed storage', async () => {
	inShell = true;
	const indexedDB = new IDBFactory();
	const refused = expectErr(
		await browser.openFolder({
			definition,
			browser: { author, indexedDb: { indexedDB, IDBKeyRange } },
		}),
	);
	expect(refused.name).toBe('InsideTauri');
	expect(await indexedDB.databases()).toEqual([]);
	expect(invoked).toEqual([]);
});

test('a browser folder defaults to a local author and local automatic history; a remote needs an explicit author', async () => {
	const indexedDB = new IDBFactory();
	const environment = { indexedDB, IDBKeyRange };
	const withoutAuthor = expectErr(
		await browser.openFolder({
			definition,
			browser: {
				remote: { url: 'http://git.test/remote.git', branch: 'main' },
				indexedDb: environment,
			},
		}),
	);
	expect(withoutAuthor.name).toBe('AuthorRequired');
	expect(
		expectErr(await browser.openFolder({ definition, id: ' ' })).name,
	).toBe('InvalidId');
	expect(await indexedDB.databases()).toEqual([]);

	const folder = expectOk(
		await browser.openFolder({
			definition,
			browser: { indexedDb: environment },
		}),
	);
	// The policy in effect is observable on the handle.
	expect(folder.git.snapshot).toMatchObject({
		commitOnEdit: true,
		remote: undefined,
		branch: 'main',
	});
	expectOk(await folder.files.create('a.md', 'a'));
	for (let waited = 0; waited < 400; waited++) {
		if (folder.git.snapshot.lastCommit !== undefined) break;
		await Bun.sleep(5);
	}
	expect(folder.git.snapshot.lastCommit?.status).toBe('committed');
	const [commit] = expectOk(await folder.git.log(1));
	expect(commit?.author).toMatchObject({
		name: 'Local',
		email: 'local@localhost',
	});
	await folder.close();
});

test('handles sharing browser storage hear each other, when the storage carries a channel', async () => {
	const environment = {
		indexedDB: new IDBFactory(),
		IDBKeyRange,
		BroadcastChannel,
	};
	const open = async () =>
		expectOk(
			await browser.openFolder({
				definition,
				browser: { author, commitOnEdit: false, indexedDb: environment },
			}),
		);
	const first = await open();
	const second = await open();
	const heardByFirst: string[] = [];
	const heardBySecond: string[] = [];
	first.onFilesChanged((paths) => heardByFirst.push(...paths));
	second.onFilesChanged((paths) => heardBySecond.push(...paths));

	expectOk(await first.files.create('from-first.md', 'x'));
	for (let waited = 0; waited < 200 && heardBySecond.length === 0; waited++)
		await Bun.sleep(5);
	expect(heardByFirst).toEqual(['from-first.md']);
	expect(heardBySecond).toEqual(['from-first.md']);
	// The second handle reads what the hint asked it to look at.
	expectOk(await second.files.read('from-first.md'));

	// A closed handle hears nothing more and stops relaying.
	await second.close();
	expectOk(await first.files.create('after-close.md', 'x'));
	await Bun.sleep(20);
	expect(heardBySecond).toEqual(['from-first.md']);
	await first.close();
});
