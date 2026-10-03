/**
 * The browser adapter: a folder in this browser's origin private file system.
 *
 * Each folder is one directory: every literal path is one stored file, every
 * directory (empty ones too) is a stored directory, and `.git` inside it is
 * the folder's private Git state. A reload reopens the same files and
 * history. This is the browser implementation and nothing else: inside the
 * desktop app it refuses, because that page's folder is a directory the
 * shell owns.
 *
 * The captured address (channel, owner, folder ID) names the directory, the
 * Web Locks, and the hint channel. The first open of an address copies the
 * folder an earlier version saved in IndexedDB for the same address, then
 * never reads IndexedDB for it again (`browser-migration.ts`). Folders are
 * never kept in IndexedDB, and nothing falls back to it.
 *
 * This module exports the opener alone. `browser.ts` is the public entry; the
 * automatic entry loads this module directly, so choosing an adapter at run
 * time never drags the other adapter's code along through shared re-exports.
 *
 * Importing this module opens nothing.
 */

import { accountKey } from '@epicenter/principal/account-key';
import { isTauri } from '@tauri-apps/api/core';
import { Ok, type Result } from 'wellcrafted/result';
import { prepareFolderDirectory } from './browser-migration.js';
import type { IndexedDbEnvironment } from './browser-store.js';
import { ensureBufferGlobal } from './buffer-global.js';
import type { OpenFolder } from './contract.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { OpenFolderError } from './errors.js';
import { assembleFolder, createFileHints, type Folder } from './folder.js';
import type { GitRemote } from './git/backend.js';
import { createStoredGitBackend } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import type { Author } from './git/objects.js';
import { createOpfsGitStore } from './git/opfs-git.js';
import { callObserver } from './observer.js';
import {
	createOpfsFileBoundary,
	holding,
	type OpfsDirectoryHandle,
	type OpfsEnvironment,
	type OpfsLocks,
} from './opfs-store.js';
import { withPublication } from './storage.js';

/** Who records history that never leaves this browser. */
const LOCAL_AUTHOR: Author = { name: 'Local', email: 'local@localhost' };

/** The browser's own storage, or the refusal naming what is missing. */
function globalEnvironment(): Result<OpfsEnvironment, OpenFolderError> {
	const scope = globalThis as Partial<IndexedDbEnvironment> & {
		navigator?: Navigator;
		FileSystemFileHandle?: { prototype: object };
		BroadcastChannel?: typeof BroadcastChannel;
	};
	if (scope.indexedDB === undefined || scope.IDBKeyRange === undefined)
		return OpenFolderError.NoIndexedDb();
	const storage = scope.navigator?.storage;
	if (typeof storage?.getDirectory !== 'function')
		return OpenFolderError.NoFileSystem({
			missing: 'navigator.storage.getDirectory',
		});
	if (!('createWritable' in (scope.FileSystemFileHandle?.prototype ?? {})))
		return OpenFolderError.NoFileSystem({
			missing: 'FileSystemFileHandle.createWritable',
		});
	const locks = scope.navigator?.locks;
	if (locks === undefined)
		return OpenFolderError.NoFileSystem({ missing: 'navigator.locks' });
	return Ok({
		getDirectory: () =>
			storage.getDirectory() as unknown as Promise<OpfsDirectoryHandle>,
		locks: locks as unknown as OpfsLocks,
		BroadcastChannel: scope.BroadcastChannel,
		indexedDb: { indexedDB: scope.indexedDB, IDBKeyRange: scope.IDBKeyRange },
	});
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this escapes.
const UNNAMEABLE = /[%/\\\u0000-\u001f\u007f]/g;

/**
 * One directory name for a folder ID or account key. Only what a directory
 * name cannot hold is escaped, and `%` with it, so distinct values stay
 * distinct names.
 */
function entryName(value: string): string {
	if (value === '.') return '%2E';
	if (value === '..') return '%2E%2E';
	return value.replace(
		UNNAMEABLE,
		(character) =>
			`%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
	);
}

function folderAddress(
	channel: 'release' | 'development',
	owner: string | null,
	id: string,
) {
	return {
		address: JSON.stringify([
			channel,
			owner === null ? 'local' : 'accounts',
			owner,
			id,
		]),
		directory: [
			channel === 'release' ? 'Epicenter' : 'Epicenter Dev',
			...(owner === null ? ['local'] : ['accounts', entryName(owner)]),
			entryName(id),
		].join('/'),
	};
}

/**
 * Open the browser folder named `id`. Refusals are returned, not thrown: a
 * definition a folder cannot keep, a page inside the desktop app, a missing
 * ID, missing browser storage, a remote without an author, or a folder an
 * earlier version saved that cannot be copied safely.
 */
export const openFolder: OpenFolder = async ({
	definition,
	id,
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
	let environment = browser.opfs;
	if (environment === undefined) {
		const found = globalEnvironment();
		if (found.error) return found;
		environment = found.data;
	}

	ensureBufferGlobal();
	// Capture ownership before the first await. Nothing below rereads the caller's
	// scope, so changing login or mutating options cannot retarget this lifetime.
	const { scope } = browser;
	const channel = scope?.channel ?? 'release';
	if (
		scope !== undefined &&
		scope?.channel !== 'release' &&
		scope?.channel !== 'development'
	)
		return OpenFolderError.InvalidBrowserScope({ reason: 'unknown channel' });
	let owner: string | null = null;
	try {
		if (scope?.account !== undefined) owner = await accountKey(scope.account);
	} catch (cause) {
		return OpenFolderError.InvalidBrowserScope({
			reason:
				cause instanceof Error ? cause.message : 'invalid account identity',
		});
	}
	return openOpfsFolder<typeof definition>(prepared.data, environment, {
		id,
		channel,
		owner,
		author,
		remote,
		commitOnEdit,
	});
};

async function openOpfsFolder<TDefinition extends FolderDefinition>(
	prepared: FolderDefinition,
	environment: OpfsEnvironment,
	captured: {
		readonly id: string;
		readonly channel: 'release' | 'development';
		/** The account key, or `null` for Local. */
		readonly owner: string | null;
		readonly author: Author;
		readonly remote: GitRemote | undefined;
		readonly commitOnEdit: boolean;
	},
): Promise<Result<Folder<TDefinition>, OpenFolderError>> {
	const { id, channel: deployment, owner, author } = captured;
	const { address, directory } = folderAddress(deployment, owner, id);
	// Release Local used the folder ID alone for its earlier database.
	const scoped = deployment !== 'release' || owner !== null;
	const { locks } = environment;
	const filesLock = `epicenter-folder-opfs-files:${address}`;
	const gitLock = `epicenter-folder-opfs-git:${address}`;
	const openLock = `epicenter-folder-opfs-open:${address}`;
	// One open at a time decides whether the directory is the folder yet, and
	// makes it so: copied from an earlier version's database, or new.
	let ready: Result<OpfsDirectoryHandle, OpenFolderError>;
	try {
		const origin = await environment.getDirectory();
		ready = await holding(locks, openLock, () =>
			prepareFolderDirectory({
				origin,
				directory,
				address,
				environment: environment.indexedDb,
				legacy: scoped
					? `epicenter-folder-scoped:${address}`
					: `epicenter-folder:${id}`,
				local: scoped
					? {
							database: `epicenter-folder:${id}`,
							...folderAddress('release', null, id),
						}
					: undefined,
			}),
		);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	if (ready.error) return ready;
	const root = ready.data;

	let channel: BroadcastChannel | undefined;
	let channelOpen = false;
	const release = () => {
		channelOpen = false;
		try {
			channel?.close();
		} catch {
			// A channel that will not close has nothing left to give back.
		}
	};
	try {
		// Other tabs of this origin share the directory. Each landed step is
		// told to them as it lands; this handle's own listeners hear a save
		// when it finishes.
		if (environment.BroadcastChannel !== undefined) {
			channel = new environment.BroadcastChannel(
				`epicenter-folder-opfs-hints:${address}`,
			);
			// A runtime that counts an open channel as pending work must not be
			// kept alive by a folder nobody closed.
			(channel as { unref?: () => void }).unref?.();
			channelOpen = true;
		}
		// A relay that fails is another tab's missed hint, never this save's
		// failure.
		const relay = (paths: readonly string[]) => {
			if (channelOpen && paths.length > 0)
				callObserver(
					'change relay',
					(landed: readonly string[]) => channel?.postMessage([...landed]),
					paths,
				);
		};
		const hints = createFileHints();
		const boundary = createOpfsFileBoundary({
			root,
			locks,
			filesLock,
			landed: relay,
		});
		const backend = await createStoredGitBackend({
			store: createOpfsGitStore({
				root,
				locks,
				filesLock,
				branch: 'main',
				landed: relay,
			}),
			locks,
			lockName: gitLock,
			branch: 'main',
			remote: captured.remote,
		});
		// An incoming update a closed tab left half published stays pending:
		// opening reads it into the snapshot and never resumes it.
		const history = createHistory({
			backend,
			boundary,
			author,
			commitOnEdit: captured.commitOnEdit,
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
			assembleFolder<TDefinition>({
				prepared,
				storage: withPublication({
					storage: boundary,
					history,
					landed: (paths) => hints.emit(paths),
				}),
				history,
				location: { kind: 'opfs', directory },
				hints,
				release: async () => release(),
			}),
		);
	} catch (cause) {
		release();
		return OpenFolderError.Unavailable({ cause });
	}
}
