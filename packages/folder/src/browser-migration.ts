/**
 * Making a browser folder's OPFS directory its authority, once (ADR-0497).
 *
 * Earlier versions kept a browser folder in one IndexedDB database. Before a
 * directory is first used as a folder, the database of the same captured
 * address is frozen, read, and copied into it: literal files, explicit
 * directories, and private Git state byte for byte. Only the database of the
 * same address is read; a Local folder is never assigned to an account. A
 * new folder goes the same way, from the empty database freezing creates, so
 * no earlier build can start one beside it.
 *
 * Freezing opens the database at `FROZEN_VERSION`. Earlier builds close
 * their connection on `versionchange` and cannot open it again, so none
 * writes once the copy begins, and every attempt reads the same snapshot. A
 * connection that does not let go refuses the copy instead of racing it. The
 * four data stores are never written: they stay as the backup. Only the
 * `migration` store is: its freeze record, and while one target file is being
 * created, a cursor naming it.
 *
 * The copy never replaces anything it did not create. Bytes equal to the
 * database's are kept; missing entries are written. Before a file is
 * created, the cursor naming it is committed, because OPFS shows a new file
 * empty until its stream closes: on a later attempt, an empty file the cursor
 * names is this copy's own and is written again, while any other empty or
 * different file, and any entry the database does not have, refuses the copy
 * and stays as it was. The cursor is cleared once the file reads back. Public
 * files, private Git files, and finally the ready marker are placed this way.
 * The directory is checked to be exactly the database before the marker is
 * written, and the marker names the captured address. A directory without a
 * readable marker for this address is never opened as a folder.
 *
 * Limits: a tab of an earlier build that stays open keeps showing what it had
 * read, and its later writes fail. Another browser profile or origin is
 * outside what this can see.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	completion,
	type IndexedDbEnvironment,
	type InventoryRecord,
	request,
	STORES,
} from './browser-store.js';
import { hashBytes } from './capture.js';
import { describe, OpenFolderError } from './errors.js';
import {
	ensureDirectory,
	lookup,
	type OpfsDirectoryHandle,
	PRIVATE_DIRECTORY,
	READY_MARKER,
	readHandle,
	walk,
	writeFileAt,
	writePrivateFile,
} from './opfs-store.js';
import { ancestors } from './paths.js';

/** Opening here closes earlier builds' connections and refuses their opens. */
export const FROZEN_VERSION = 2;
/** The one store migration writes, beside the four it only reads. */
export const MIGRATION_STORE = 'migration';
const GIT_PREFIX = '/git/';
const MARKER_PATH = `${PRIVATE_DIRECTORY}/${READY_MARKER}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The target file a copy committed to creating, and has not seen read back. */
export type MigrationCursor = {
	readonly address: string;
	/** The target path relative to the folder's directory, `.git/...` for private files. */
	readonly path: string;
	readonly phase: 'creating';
};

/**
 * Open `name` at `FROZEN_VERSION`, creating it, or upgrading an earlier
 * build's, with the four folder stores and the freeze record. `'blocked'`
 * when another connection does not close; that open finishes later and is
 * closed then.
 */
function freeze(
	environment: IndexedDbEnvironment,
	name: string,
	address: string,
): Promise<IDBDatabase | 'blocked'> {
	return new Promise((resolve, reject) => {
		const opening = environment.indexedDB.open(name, FROZEN_VERSION);
		let answered = false;
		opening.onupgradeneeded = (event) => {
			const db = opening.result;
			for (const store of Object.values(STORES))
				if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
			if (!db.objectStoreNames.contains(MIGRATION_STORE))
				db.createObjectStore(MIGRATION_STORE).put(
					{ address, fromVersion: event.oldVersion, frozenAt: Date.now() },
					'frozen',
				);
		};
		opening.onblocked = () => {
			if (answered) return;
			answered = true;
			resolve('blocked');
		};
		opening.onsuccess = () => {
			const db = opening.result;
			if (answered) {
				db.close();
				return;
			}
			answered = true;
			db.onversionchange = () => db.close();
			resolve(db);
		};
		opening.onerror = () => {
			if (answered) return;
			answered = true;
			reject(opening.error);
		};
	});
}

type LegacyFolder = {
	/** The version the database had before it was frozen; 0 when freezing created it. */
	readonly fromVersion: number;
	readonly files: ReadonlyMap<string, Uint8Array>;
	readonly directories: ReadonlySet<string>;
	/** Private Git files by their path inside `.git`. */
	readonly git: ReadonlyMap<string, Uint8Array>;
};

/**
 * Read and check the whole frozen database in one read transaction. Frozen,
 * it is the same snapshot on every attempt; its freeze record must name this
 * address.
 */
async function readLegacy(
	db: IDBDatabase,
	address: string,
): Promise<LegacyFolder> {
	const tx = db.transaction(
		[...Object.values(STORES), MIGRATION_STORE],
		'readonly',
	);
	const frozen = (await request(
		tx.objectStore(MIGRATION_STORE).get('frozen'),
	)) as { address?: string; fromVersion?: number } | undefined;
	if (frozen?.address !== address)
		throw new Error(
			`The database was frozen for ${String(frozen?.address)}, not ${address}`,
		);
	const all = (store: string) =>
		Promise.all([
			request(tx.objectStore(store).getAllKeys()) as Promise<string[]>,
			request(tx.objectStore(store).getAll()) as Promise<unknown[]>,
		]);
	const [inventoryKeys, inventory] = await all(STORES.inventory);
	const [contentKeys, contents] = await all(STORES.contents);
	const [directoryKeys] = await all(STORES.directories);
	const [gitKeys, gitValues] = await all(STORES.git);

	const bytesByPath = new Map<string, Uint8Array>();
	for (const [index, path] of contentKeys.entries())
		bytesByPath.set(path, contents[index] as Uint8Array);
	const files = new Map<string, Uint8Array>();
	for (const [index, path] of inventoryKeys.entries()) {
		const record = inventory[index] as InventoryRecord;
		const bytes = bytesByPath.get(path);
		if (!(bytes instanceof Uint8Array))
			throw new Error(`'${path}' has metadata but no stored bytes`);
		if (
			bytes.byteLength !== record.size ||
			(await hashBytes(bytes)) !== record.sha256
		)
			throw new Error(`'${path}' does not match its recorded size and SHA-256`);
		files.set(path, bytes);
		bytesByPath.delete(path);
	}
	if (bytesByPath.size > 0)
		throw new Error(
			`${[...bytesByPath.keys()].join(', ')} ${bytesByPath.size === 1 ? 'has' : 'have'} stored bytes but no metadata`,
		);
	const git = new Map<string, Uint8Array>();
	for (const [index, key] of gitKeys.entries()) {
		if (!key.startsWith(GIT_PREFIX))
			throw new Error(`The private Git key '${key}' is outside '/git/'`);
		git.set(key.slice(GIT_PREFIX.length), gitValues[index] as Uint8Array);
	}
	// Earlier builds recorded only the directories the shell made, often only
	// the deepest; every directory above one of those, or above a file, is
	// the folder's too.
	const directories = new Set(directoryKeys);
	for (const path of [...files.keys(), ...directoryKeys])
		for (const parent of ancestors(path)) directories.add(parent);
	return { fromVersion: frozen.fromVersion ?? 0, files, directories, git };
}

async function readCursor(
	db: IDBDatabase,
): Promise<MigrationCursor | undefined> {
	return (await request(
		db.transaction(MIGRATION_STORE).objectStore(MIGRATION_STORE).get('cursor'),
	)) as MigrationCursor | undefined;
}

/** Commit `cursor`, or clear it with `undefined`; resolves once durable. */
async function writeCursor(
	db: IDBDatabase,
	cursor: MigrationCursor | undefined,
) {
	const tx = db.transaction(MIGRATION_STORE, 'readwrite', {
		durability: 'strict',
	});
	const done = completion(tx);
	if (cursor === undefined) tx.objectStore(MIGRATION_STORE).delete('cursor');
	else tx.objectStore(MIGRATION_STORE).put(cursor, 'cursor');
	await done;
}

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
	left.byteLength === right.byteLength &&
	left.every((byte, index) => byte === right[index]);

const divergent = (path: string) =>
	new Error(
		`'${path}' already holds something other than the database's copy, and this copy did not create it; it was left unchanged`,
	);

/** Every private file under `.git`, by its path inside it. */
async function privateFiles(target: OpfsDirectoryHandle) {
	const files = new Map<string, Uint8Array>();
	async function visit(directory: OpfsDirectoryHandle, prefix: string) {
		for await (const entry of directory.values()) {
			const path = `${prefix}${entry.name}`;
			if (entry.kind === 'directory') await visit(entry, `${path}/`);
			else files.set(path, await readHandle(entry));
		}
	}
	const found = await lookup(target, PRIVATE_DIRECTORY);
	if (found.kind === 'directory') await visit(found.handle, '');
	return files;
}

/**
 * Copy `legacy` into `target`, one cursor-owned creation at a time, then
 * require that the directory is exactly the database.
 */
async function copy(
	db: IDBDatabase,
	target: OpfsDirectoryHandle,
	legacy: LegacyFolder,
	address: string,
) {
	let cursor = await readCursor(db);
	if (cursor !== undefined && cursor.address !== address)
		throw new Error(
			`The copy's cursor names ${cursor.address}, not ${address}; it was left as it was`,
		);

	/** Put `bytes` at `path`, creating it only under a committed cursor. */
	async function place(
		path: string,
		bytes: Uint8Array,
		write: (rewrite: boolean) => Promise<void>,
	) {
		const owned = cursor?.path === path;
		const at = await lookup(target, path);
		let rewrite = false;
		if (at.kind === 'file') {
			const now = await readHandle(at.handle);
			if (sameBytes(now, bytes)) {
				if (owned) {
					await writeCursor(db, undefined);
					cursor = undefined;
				}
				return;
			}
			// Only an empty file this copy began creating is its own to finish.
			if (!(owned && now.byteLength === 0)) throw divergent(path);
			rewrite = true;
		} else if (at.kind !== 'absent') throw divergent(path);
		if (!owned) {
			cursor = { address, path, phase: 'creating' };
			await writeCursor(db, cursor);
		}
		await write(rewrite);
		const landed = await lookup(target, path);
		if (
			landed.kind !== 'file' ||
			!sameBytes(await readHandle(landed.handle), bytes)
		)
			throw new Error(`'${path}' did not read back as the bytes copied`);
		await writeCursor(db, undefined);
		cursor = undefined;
	}

	for (const directory of [...legacy.directories].sort()) {
		const at = await lookup(target, directory);
		if (at.kind === 'directory') continue;
		if (at.kind !== 'absent') throw divergent(directory);
		const made = await ensureDirectory(target, directory);
		if (made.error) throw new Error(made.error.message);
	}
	for (const [path, bytes] of legacy.files)
		await place(path, bytes, async (rewrite) => {
			const written = await writeFileAt(target, path, bytes, {
				exists: rewrite,
			});
			if (written.error) throw new Error(written.error.message);
		});
	for (const [path, bytes] of legacy.git)
		await place(`${PRIVATE_DIRECTORY}/${path}`, bytes, () =>
			writePrivateFile(target, path, bytes),
		);

	// Anything else was already there: it is kept, and the copy is refused.
	const files = new Map<string, Uint8Array>();
	const directories = new Set<string>();
	await walk(target, '', {
		async file(path, handle) {
			files.set(path, await readHandle(handle));
		},
		directory: (path) => directories.add(path),
	});
	const extra: string[] = [];
	for (const [path, bytes] of files) {
		const expected = legacy.files.get(path);
		if (expected === undefined) extra.push(path);
		else if (!sameBytes(bytes, expected))
			throw new Error(`'${path}' did not read back as the bytes copied`);
	}
	for (const path of legacy.files.keys())
		if (!files.has(path)) throw new Error(`'${path}' was not copied`);
	for (const directory of directories)
		if (!legacy.directories.has(directory)) extra.push(`${directory}/`);
	for (const directory of legacy.directories)
		if (!directories.has(directory))
			throw new Error(`'${directory}/' did not read back as a directory`);
	const copiedGit = await privateFiles(target);
	// The marker is placed last, after this check, and only under a cursor.
	for (const path of copiedGit.keys())
		if (!legacy.git.has(path) && path !== READY_MARKER)
			extra.push(`${PRIVATE_DIRECTORY}/${path}`);
	if (extra.length > 0)
		throw new Error(
			`The directory holds entries the database does not, left unchanged: ${extra.sort().join(', ')}`,
		);
	for (const [path, bytes] of legacy.git) {
		const copied = copiedGit.get(path);
		if (copied === undefined || !sameBytes(copied, bytes))
			throw new Error(`Private Git file '${path}' did not read back exactly`);
	}

	return (marker: Uint8Array) =>
		place(MARKER_PATH, marker, () =>
			writePrivateFile(target, READY_MARKER, marker),
		);
}

type Marker = {
	readonly address: string;
	readonly migratedFrom: { database: string; version: number } | null;
};

/**
 * The ready marker of the folder at `directory`: absent (an empty one never
 * published), the address it names, or why it cannot be read.
 */
async function readMarker(
	origin: OpfsDirectoryHandle,
	directory: string,
): Promise<
	| { readonly kind: 'absent' }
	| { readonly kind: 'ready'; readonly address: unknown }
	| { readonly kind: 'unreadable'; readonly cause: unknown }
> {
	const found = await lookup(origin, `${directory}/${MARKER_PATH}`);
	const bytes =
		found.kind === 'file' ? await readHandle(found.handle) : undefined;
	if (bytes === undefined || bytes.byteLength === 0) return { kind: 'absent' };
	try {
		return {
			kind: 'ready',
			address: (JSON.parse(decoder.decode(bytes)) as Partial<Marker>).address,
		};
	} catch (cause) {
		return { kind: 'unreadable', cause };
	}
}

/** Where release Local keeps a folder ID, for a scoped folder of the same ID. */
export type LocalFolder = {
	/** The database earlier builds kept the Local folder in. */
	readonly database: string;
	readonly address: string;
	/** Its directory below the origin's private root. */
	readonly directory: string;
};

/**
 * Whether a scoped folder with nothing of its own may start while `local`
 * may still hold an earlier build's folder. A Local folder this version
 * opened is its own; the scoped one starts beside it. Otherwise the Local
 * database is frozen, exactly as a Local open freezes it, so no earlier
 * build can write it from here on, and what it holds then decides: nothing
 * lets the scoped folder start, and anything is a folder no Local open has
 * claimed, which is never given to this scope. A freeze, even one an
 * earlier version's open did not follow with a copy, proves nothing.
 */
async function localFence(
	origin: OpfsDirectoryHandle,
	environment: IndexedDbEnvironment,
	local: LocalFolder,
): Promise<OpenFolderError | undefined> {
	const marker = await readMarker(origin, local.directory);
	if (marker.kind === 'ready' && marker.address === local.address)
		return undefined;
	const unassigned = OpenFolderError.LegacyScopeUnassigned({
		database: local.database,
	}).error;
	let db: IDBDatabase | 'blocked';
	try {
		db = await freeze(environment, local.database, local.address);
	} catch (cause) {
		return OpenFolderError.LegacyMigration({ database: local.database, cause })
			.error;
	}
	if (db === 'blocked')
		return OpenFolderError.LegacyInUse({ database: local.database }).error;
	try {
		const held = await readLegacy(db, local.address);
		const empty =
			held.files.size === 0 &&
			held.directories.size === 0 &&
			held.git.size === 0;
		return empty ? undefined : unassigned;
	} catch {
		// What cannot be read cannot be shown to be empty.
		return unassigned;
	} finally {
		db.close();
	}
}

/**
 * Make the folder's directory its authority, under the folder's open lock,
 * and return it: it is ready already, or the database of the same address
 * (`legacy`) is frozen and copied into it, a new database freezing empty.
 * A scoped folder names the Local folder of its ID in `local`: when its own
 * frozen database holds nothing, it starts only past `localFence`. Such a
 * refusal leaves the two databases frozen and nothing else.
 */
export async function prepareFolderDirectory({
	origin,
	directory,
	address,
	environment,
	legacy,
	local,
}: {
	/** The origin's private root. */
	origin: OpfsDirectoryHandle;
	/** The folder's directory below it. */
	directory: string;
	/** The captured address, recorded in the marker and the frozen database. */
	address: string;
	environment: IndexedDbEnvironment;
	legacy: string;
	local: LocalFolder | undefined;
}): Promise<Result<OpfsDirectoryHandle, OpenFolderError>> {
	try {
		// An empty marker is one whose creation never published: the copy
		// below finishes it only if its cursor names it.
		const marker = await readMarker(origin, directory);
		if (marker.kind === 'unreadable')
			return OpenFolderError.Unavailable({
				cause: new Error(
					`The directory '${directory}' has a ready marker that cannot be read: ${describe(marker.cause)}`,
				),
			});
		if (marker.kind === 'ready') {
			if (marker.address !== address)
				return OpenFolderError.Unavailable({
					cause: new Error(
						`The directory '${directory}' is marked for ${String(marker.address)}, not ${address}`,
					),
				});
			const found = await lookup(origin, directory);
			if (found.kind === 'directory') return Ok(found.handle);
		}
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	let db: IDBDatabase | 'blocked';
	try {
		db = await freeze(environment, legacy, address);
	} catch (cause) {
		return OpenFolderError.LegacyMigration({ database: legacy, cause });
	}
	if (db === 'blocked')
		return OpenFolderError.LegacyInUse({ database: legacy });
	try {
		// What the frozen database holds decides, whatever was seen before the
		// freeze: an earlier build may have saved in between.
		const folder = await readLegacy(db, address);
		if (
			local !== undefined &&
			folder.files.size === 0 &&
			folder.directories.size === 0 &&
			folder.git.size === 0
		) {
			const fenced = await localFence(origin, environment, local);
			if (fenced !== undefined) return Err(fenced);
		}
		const made = await ensureDirectory(origin, directory);
		if (made.error) throw new Error(made.error.message);
		const target = made.data;
		const placeMarker = await copy(db, target, folder, address);
		const marker: Marker = {
			address,
			migratedFrom:
				folder.fromVersion === 0
					? null
					: { database: legacy, version: folder.fromVersion },
		};
		await placeMarker(encoder.encode(JSON.stringify(marker)));
		return Ok(target);
	} catch (cause) {
		return OpenFolderError.LegacyMigration({ database: legacy, cause });
	} finally {
		db.close();
	}
}
