/**
 * Test helper: folders as earlier versions kept them, in one IndexedDB
 * database per folder at version 1 (`browser-store.ts`).
 *
 * `seedLegacyFolder` writes such a database. Its contents usually come from
 * `legacyContents`, which reads a folder the production opener made in a
 * scratch stand-in tree, so the database holds real Git history: objects,
 * refs, `HEAD`, config, and index under `/git/...`.
 */

import {
	completion,
	type IndexedDbEnvironment,
	request,
	STORES,
} from './browser-store.js';
import { hashBytes } from './capture.js';
import type { MemoryOpfs } from './opfs.test-support.js';
import { ancestors } from './paths.js';

export type LegacyContents = {
	readonly files: ReadonlyMap<string, Uint8Array>;
	/** Explicit directories, as the shell kept them. */
	readonly directories: readonly string[];
	/** Private Git files by their path inside `.git`. */
	readonly git: ReadonlyMap<string, Uint8Array>;
};

/** The files, directories, and private Git files of the folder at `directory` of `tree`. */
export function legacyContents(
	tree: MemoryOpfs,
	directory: string,
): LegacyContents {
	const files = new Map<string, Uint8Array>();
	const git = new Map<string, Uint8Array>();
	for (const [path, bytes] of tree.files(directory)) {
		if (path === '.git/epicenter-folder.json') continue;
		if (path.startsWith('.git/')) git.set(path.slice(5), bytes);
		else files.set(path, bytes);
	}
	const implied = new Set([...files.keys()].flatMap((path) => ancestors(path)));
	const directories = tree
		.directories(directory)
		.filter(
			(path) =>
				path !== '.git' && !path.startsWith('.git/') && !implied.has(path),
		);
	return { files, directories, git };
}

/** Open (creating) `database` at version 1 with the four stores, as earlier builds did. */
export function openLegacyDatabase(
	environment: IndexedDbEnvironment,
	database: string,
): Promise<IDBDatabase> {
	const opening = environment.indexedDB.open(database, 1);
	opening.onupgradeneeded = () => {
		for (const store of Object.values(STORES))
			if (!opening.result.objectStoreNames.contains(store))
				opening.result.createObjectStore(store);
	};
	return request(opening);
}

/** Write `contents` as an earlier version's folder database named `database`. */
export async function seedLegacyFolder(
	environment: IndexedDbEnvironment,
	database: string,
	contents: LegacyContents,
): Promise<void> {
	const db = await openLegacyDatabase(environment, database);
	const records = new Map<string, { sha256: string; size: number }>();
	for (const [path, bytes] of contents.files)
		records.set(path, {
			sha256: await hashBytes(bytes),
			size: bytes.byteLength,
		});
	const tx = db.transaction(Object.values(STORES), 'readwrite');
	const done = completion(tx);
	let ino = 1;
	for (const [path, bytes] of contents.files) {
		const record = records.get(path)!;
		tx.objectStore(STORES.inventory).put(
			{ ...record, mtimeMs: Date.now(), ino: ino++ },
			path,
		);
		tx.objectStore(STORES.contents).put(bytes, path);
	}
	for (const path of contents.directories)
		tx.objectStore(STORES.directories).put(true, path);
	for (const [path, bytes] of contents.git)
		tx.objectStore(STORES.git).put(bytes, `/git/${path}`);
	await done;
	db.close();
}
