/**
 * Test helper: the browser storage browser suites run on, which is what a
 * browser opens: the origin private file system, here the in-memory
 * stand-in (`opfs.test-support.ts`), with a fake IndexedDB for the earlier
 * folders a first open looks for.
 *
 * Suites open browser folders with `browserStorage(storage)` or build raw
 * storage with `rawBrowserFolder`. One IndexedDB factory always reaches one
 * stand-in tree, so a suite that reopens with the same storage reopens the
 * same folder, and a raw folder built for an ID is the folder the opener
 * opens for that ID. Where the shared `navigator.locks` stand-in is not
 * installed, a private one is used: browser folders require Web Locks.
 *
 * Application tests import this file by its path. `testBrowserStorage()`
 * gives them fresh storage in one call.
 */
import { createHash } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { FileBoundary } from './boundary.js';
import type { IndexedDbEnvironment } from './browser-store.js';
import type { BrowserFolderOptions } from './contract.js';
import type { FolderLocation } from './folder.js';
import type { GitBackend, GitRemote } from './git/backend.js';
import { createStoredGitBackend } from './git/browser-backend.js';
import { createOpfsGitStore } from './git/opfs-git.js';
import { type MemoryOpfs, memoryOpfs } from './opfs.test-support.js';
import {
	createOpfsFileBoundary,
	ensureDirectory,
	type OpfsLocks,
	READY_MARKER,
	writePrivateFile,
} from './opfs-store.js';
import { createWebLocks } from './web-locks.test-support.js';

/** A test's IndexedDB, and optionally the channel its handles relay hints on. */
export type TestStorage = IndexedDbEnvironment & {
	readonly BroadcastChannel?: typeof BroadcastChannel;
};

const trees = new WeakMap<IDBFactory, MemoryOpfs>();
const fallback = createWebLocks() as unknown as OpfsLocks;

/** `navigator.locks` when a test installed it, otherwise a private stand-in. */
export const testLocks: OpfsLocks = {
	request: (name, options, work) =>
		(
			(globalThis.navigator as unknown as { locks?: OpfsLocks } | undefined)
				?.locks ?? fallback
		).request(name, options, work),
};

/** The stand-in tree behind `storage`. */
export function opfsOf(storage: IndexedDbEnvironment): MemoryOpfs {
	let tree = trees.get(storage.indexedDB as IDBFactory);
	if (tree === undefined) {
		tree = memoryOpfs();
		trees.set(storage.indexedDB as IDBFactory, tree);
	}
	return tree;
}

/** `browser` options that open the stand-in tree behind `storage`. */
export function browserStorage(
	storage: TestStorage,
): Pick<BrowserFolderOptions, 'opfs'> {
	const tree = opfsOf(storage);
	return {
		opfs: {
			getDirectory: () => tree.getDirectory(),
			locks: testLocks,
			indexedDb: {
				indexedDB: storage.indexedDB,
				IDBKeyRange: storage.IDBKeyRange,
			},
			BroadcastChannel: storage.BroadcastChannel,
		},
	};
}

/** `browser` options for fresh, empty storage. */
export function testBrowserStorage(
	options: { BroadcastChannel?: typeof BroadcastChannel } = {},
): Pick<BrowserFolderOptions, 'opfs'> {
	return browserStorage({
		indexedDB: new IDBFactory(),
		IDBKeyRange,
		BroadcastChannel: options.BroadcastChannel,
	});
}

/** Where the opener keeps release Local folder `id`. */
export function locationOf(id: string): FolderLocation {
	return { kind: 'opfs', directory: `Epicenter/local/${id}` };
}

export type RawBrowserFolder = {
	readonly boundary: FileBoundary;
	/** A Git backend on the same storage, with the locks the opener uses. */
	backend(options?: {
		branch?: string;
		remote?: GitRemote;
	}): Promise<GitBackend>;
	/**
	 * Every stored entry except Git objects, by kind and path, with values
	 * hashed: what an operation that wrote nothing must leave equal.
	 */
	dump(): Promise<Record<string, string>>;
	readonly opfs: MemoryOpfs;
};

const digest = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

const skipObjects = (key: string) => key.startsWith('/git/objects/');

/**
 * Every stored entry of release Local folder `id`, values hashed, creating
 * nothing. `contents:` and `directories:` take folder paths, `git:` takes
 * `/git/...` paths. `skip` leaves out keys an operation may change without
 * writing the folder: by default Git objects.
 */
export async function dumpStorage(
	storage: IndexedDbEnvironment,
	id: string,
	skip: (key: string) => boolean = skipObjects,
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const tree = opfsOf(storage);
	const directory = `Epicenter/local/${id}`;
	for (const [path, bytes] of tree.files(directory)) {
		const [kind, key] = path.startsWith('.git/')
			? ['git', `/git/${path.slice(5)}`]
			: ['contents', path];
		// The marker is how the opener knows the directory; it is not data.
		if (key === '/git/epicenter-folder.json' || skip(key)) continue;
		result[`${kind}:${key}`] = digest(bytes);
	}
	for (const path of tree.directories(directory))
		if (path !== '.git' && !path.startsWith('.git/'))
			result[`directories:${path}`] = '';
	return result;
}

/**
 * Raw storage for release Local folder `id`: the folder the opener opens for
 * that ID with the same storage.
 */
export async function rawBrowserFolder({
	id,
	storage = { indexedDB: new IDBFactory(), IDBKeyRange },
}: {
	id: string;
	storage?: IndexedDbEnvironment;
}): Promise<RawBrowserFolder> {
	const address = JSON.stringify(['release', 'local', null, id]);
	const tree = opfsOf(storage);
	const directory = `Epicenter/local/${id}`;
	const made = await ensureDirectory(await tree.getDirectory(), directory);
	if (made.error) throw new Error(made.error.message);
	const root = made.data;
	await writePrivateFile(
		root,
		READY_MARKER,
		new TextEncoder().encode(JSON.stringify({ address, migratedFrom: null })),
	);
	const filesLock = `epicenter-folder-opfs-files:${address}`;
	return {
		boundary: createOpfsFileBoundary({
			root,
			locks: testLocks,
			filesLock,
			landed: () => {},
		}),
		backend: ({ branch = 'main', remote } = {}) =>
			createStoredGitBackend({
				store: createOpfsGitStore({
					root,
					locks: testLocks,
					filesLock,
					branch,
					landed: () => {},
				}),
				locks: testLocks,
				lockName: `epicenter-folder-opfs-git:${address}`,
				branch,
				remote,
			}),
		dump: () => dumpStorage(storage, id),
		opfs: tree,
	};
}
