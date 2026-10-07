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
 * Web Locks, and the hint channel. The directory is the folder only while its
 * ready marker names that address (`claimDirectory`). IndexedDB is never
 * required, read, or written.
 *
 * This module exports the opener alone. `browser.ts` is the public entry; the
 * automatic entry loads this module directly, so choosing an adapter at run
 * time never drags the other adapter's code along through shared re-exports.
 *
 * Importing this module opens nothing.
 */

import { accountKey } from '@epicenter/principal/account-key';
import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
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
import type { GitFetch } from './git/http.js';
import type { Author } from './git/objects.js';
import { createOpfsGitStore } from './git/opfs-git.js';
import { callObserver } from './observer.js';
import {
	createOpfsFileBoundary,
	ensureDirectory,
	holding,
	lookup,
	type OpfsDirectoryHandle,
	type OpfsEnvironment,
	type OpfsLocks,
	PRIVATE_DIRECTORY,
	READY_MARKER,
	readHandle,
	writePrivateFile,
} from './opfs-store.js';
import { withPublication } from './storage.js';

/** Who records history that never leaves this browser. */
const LOCAL_AUTHOR: Author = { name: 'Local', email: 'local@localhost' };

/** The browser's own storage, or the refusal naming what is missing. */
function globalEnvironment(): Result<OpfsEnvironment, OpenFolderError> {
	const scope = globalThis as {
		navigator?: Navigator;
		FileSystemFileHandle?: { prototype: object };
		BroadcastChannel?: typeof BroadcastChannel;
	};
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

const MARKER_PATH = `${PRIVATE_DIRECTORY}/${READY_MARKER}`;

/** The address a ready marker names, or `undefined` when it names none. */
function markedAddress(bytes: Uint8Array): string | undefined {
	try {
		const marker: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(bytes),
		);
		// Extra record properties do not affect directory identity.
		if (
			typeof marker === 'object' &&
			marker !== null &&
			'address' in marker &&
			typeof marker.address === 'string'
		)
			return marker.address;
	} catch {
		// Not JSON text: it names no address.
	}
	return undefined;
}

/**
 * The first entry of an unmarked folder directory that is not what an
 * interrupted first open leaves: `.git` holding at most an empty marker.
 */
async function occupant(
	directory: OpfsDirectoryHandle,
): Promise<string | undefined> {
	for await (const entry of directory.values()) {
		if (entry.name !== PRIVATE_DIRECTORY || entry.kind !== 'directory')
			return entry.name;
		for await (const inner of entry.values()) {
			const path = `${PRIVATE_DIRECTORY}/${inner.name}`;
			if (inner.kind !== 'file' || inner.name !== READY_MARKER) return path;
			if ((await readHandle(inner)).byteLength > 0) return path;
		}
	}
	return undefined;
}

/**
 * Make `directory` the folder at `address`, under the folder's open lock. A
 * directory whose ready marker names `address` is the folder. One whose
 * marker names another address, or names none, is refused, and so is one
 * that holds anything without a marker: nothing there is overwritten or
 * adopted. A missing or empty directory becomes the folder once its marker
 * is written; a marker write that fails, or whose close is unconfirmed,
 * throws, and the open is refused. An empty marker publishes nothing, so a
 * directory holding only one is still empty.
 */
async function claimDirectory(
	origin: OpfsDirectoryHandle,
	directory: string,
	address: string,
): Promise<Result<OpfsDirectoryHandle, OpenFolderError>> {
	const refused = (reason: string) =>
		OpenFolderError.Unavailable({
			cause: new Error(
				`The directory '${directory}' ${reason}; it was left unchanged`,
			),
		});
	const found = await lookup(origin, directory);
	if (found.kind === 'file' || found.kind === 'underFile')
		return refused('is not a directory');
	if (found.kind === 'directory') {
		const marker = await lookup(found.handle, MARKER_PATH);
		const bytes =
			marker.kind === 'file' ? await readHandle(marker.handle) : undefined;
		if (bytes !== undefined && bytes.byteLength > 0) {
			const marked = markedAddress(bytes);
			if (marked === undefined)
				return refused('has a ready marker that names no address');
			if (marked !== address)
				return refused(`is marked for ${marked}, not ${address}`);
			return Ok(found.handle);
		}
		const held = await occupant(found.handle);
		if (held !== undefined)
			return refused(`holds '${held}' but no ready marker for ${address}`);
	}
	const { data: made, error: directoryError } = await ensureDirectory(
		origin,
		directory,
	);
	if (directoryError !== null)
		return OpenFolderError.Unavailable({ cause: directoryError });
	await writePrivateFile(
		made,
		READY_MARKER,
		new TextEncoder().encode(JSON.stringify({ address })),
	);
	return Ok(made);
}

/**
 * Open the browser folder named `id`. Refusals are returned, not thrown: a
 * definition a folder cannot keep, a page inside the desktop app, a missing
 * ID, missing browser storage, a remote without an author, or a directory
 * that is not this folder's.
 */
export const openFolder: OpenFolder = async ({
	definition,
	id,
	browser = {},
}) => {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	const { remote, commitOnEdit = true } = browser;
	if (remote !== undefined && browser.author === undefined)
		return OpenFolderError.AuthorRequired();
	const author = browser.author ?? LOCAL_AUTHOR;
	let environment = browser.opfs;
	if (environment === undefined) {
		const { data: found, error: environmentError } = globalEnvironment();
		if (environmentError !== null) return Err(environmentError);
		environment = found;
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
	return openOpfsFolder<typeof definition>(prepared, environment, {
		id,
		channel,
		owner,
		author,
		remote,
		gitFetch: browser.gitFetch,
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
		readonly gitFetch: GitFetch | undefined;
		readonly commitOnEdit: boolean;
	},
): Promise<Result<Folder<TDefinition>, OpenFolderError>> {
	const { id, channel: deployment, owner, author } = captured;
	const { address, directory } = folderAddress(deployment, owner, id);
	const { locks } = environment;
	const filesLock = `epicenter-folder-opfs-files:${address}`;
	const gitLock = `epicenter-folder-opfs-git:${address}`;
	const openLock = `epicenter-folder-opfs-open:${address}`;
	// One open at a time decides whether the directory is the folder yet, and
	// makes a new one so.
	let ready: Result<OpfsDirectoryHandle, OpenFolderError>;
	try {
		const origin = await environment.getDirectory();
		ready = await holding(locks, openLock, () =>
			claimDirectory(origin, directory, address),
		);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	const { data: root, error: readyError } = ready;
	if (readyError !== null) return Err(readyError);

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
			gitFetch: captured.gitFetch,
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
