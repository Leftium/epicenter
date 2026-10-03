/**
 * The browser adapter: a folder in this browser's own storage.
 *
 * Files, directories, Git objects, refs, and the index persist in one
 * IndexedDB database named for the folder's ID, so a reload reopens the same
 * folder and history. This is the browser implementation and nothing else:
 * inside the desktop app it refuses, because that page's folder is a
 * directory the shell owns.
 *
 * This module exports the opener alone. `browser.ts` is the public entry; the
 * automatic entry loads this module directly, so choosing an adapter at run
 * time never drags the other adapter's code along through shared re-exports.
 *
 * Importing this module opens nothing.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import {
	createBrowserFileBoundary,
	type IndexedDbEnvironment,
	openFolderDatabase,
} from './browser-store.js';
import { ensureBufferGlobal } from './buffer-global.js';
import type { OpenFolder } from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { OpenFolderError } from './errors.js';
import { assembleFolder, createFileHints } from './folder.js';
import { createBrowserGitBackend } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import type { Author } from './git/objects.js';
import { withPublication } from './storage.js';

/** Who records history that never leaves this browser. */
const LOCAL_AUTHOR: Author = { name: 'Local', email: 'local@localhost' };

/** The browser's own storage, or `undefined` where there is none. */
function globalEnvironment(): IndexedDbEnvironment | undefined {
	const scope = globalThis as Partial<IndexedDbEnvironment>;
	if (scope.indexedDB === undefined || scope.IDBKeyRange === undefined)
		return undefined;
	return {
		indexedDB: scope.indexedDB,
		IDBKeyRange: scope.IDBKeyRange,
		BroadcastChannel: scope.BroadcastChannel,
	};
}

/**
 * Open a browser folder. Refusals are returned, not thrown: a definition a
 * folder cannot keep, a page inside the desktop app, no IndexedDB, or a
 * remote without an author.
 */
export const openFolder: OpenFolder = async ({
	definition,
	id = definition.id,
	browser = {},
}) => {
	const prepared = prepareFolderDefinition(definition);
	if (prepared.error) return OpenFolderError.InvalidDefinition(prepared.error);
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	const { remote, commitOnEdit = true } = browser;
	if (remote !== undefined && browser.author === undefined)
		return OpenFolderError.AuthorRequired();
	const author = browser.author ?? LOCAL_AUTHOR;
	const environment = browser.indexedDb ?? globalEnvironment();
	if (environment === undefined) return OpenFolderError.NoIndexedDb();

	ensureBufferGlobal();
	const database = `epicenter-folder:${id}`;
	let db: IDBDatabase;
	try {
		db = await openFolderDatabase(database, environment);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	// Everything acquired from here on is given back by `release`, whether the
	// folder closes or the rest of this open fails.
	let channel: BroadcastChannel | undefined;
	let channelOpen = false;
	const release = () => {
		channelOpen = false;
		try {
			channel?.close();
		} catch {
			// A channel that will not close has nothing left to give back; the
			// database below is what must be released.
		}
		db.close();
	};
	try {
		const hints = createFileHints((paths) => {
			if (channelOpen) channel?.postMessage([...paths]);
		});
		// Other tabs of this origin share the database. Each tells the others
		// which paths its saves reached.
		if (environment.BroadcastChannel !== undefined) {
			channel = new environment.BroadcastChannel(
				`epicenter-folder-files:${id}`,
			);
			// A runtime that counts an open channel as pending work must not be
			// kept alive by a folder nobody closed.
			(channel as { unref?: () => void }).unref?.();
			channelOpen = true;
		}
		const boundary = createBrowserFileBoundary(db, environment);
		const backend = await createBrowserGitBackend({
			db,
			environment,
			lockName: `epicenter-folder-git:${id}`,
			branch: remote?.branch ?? 'main',
			remote,
		});
		const history = createHistory({
			backend,
			boundary,
			author,
			commitOnEdit,
			landed: (paths) => hints.emit(paths),
		});
		if (channel !== undefined) {
			channel.onmessage = ({ data }) => {
				if (!channelOpen || history.snapshot.closed || !Array.isArray(data))
					return;
				history.noteEdit();
				hints.receive(data as string[]);
			};
		}
		return Ok(
			assembleFolder<typeof definition>({
				prepared: prepared.data,
				storage: withPublication({
					storage: boundary,
					history,
					landed: (paths) => hints.emit(paths),
				}),
				history,
				location: { kind: 'indexedDb', database },
				hints,
				release: async () => release(),
			}),
		);
	} catch (cause) {
		release();
		return OpenFolderError.Unavailable({ cause });
	}
};
