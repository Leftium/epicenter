/**
 * Ordinary files in a native folder.
 *
 * Current files are the source. A conditional write hashes the current bytes
 * and replaces them only when they match; this is a best-effort check, not an
 * operating-system-wide compare-and-swap against other programs. Exclusive
 * creation and moves use hard links, which fail rather than overwrite an
 * existing destination. Replacement writes a scratch file under
 * `.git/epicenter/scratch`, checks again that a file is at the path (with the
 * expected sha256, when one is given), and renames the scratch file into
 * place. The second check catches a writer that landed, or a removal, while
 * the bytes were being staged; a writer or removal between that check and the
 * rename is still overwritten.
 *
 * One boundary applies its batches one at a time, so two saves through the
 * same opened folder never share that window: the later one checks against
 * what the earlier one left. A capture's enumeration and reads take the same
 * turn, so it never sees one of this boundary's batches half applied. This
 * orders this boundary's own batches and captures only. It is
 * not a file lock, and another program or a second boundary on the same
 * directory still races as described above. Other reads are not ordered.
 *
 * A multi-file batch applies ordered steps. When a step fails, the result
 * reports which steps reached the folder; nothing is rolled back.
 */
import {
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	CapturedFiles,
	FileBoundary,
	FileChange,
	FileListing,
	FileRead,
} from './boundary.js';
import { ApplyError, FileError, type FileStep } from './errors.js';
import { ancestors, isPortablePath, pathProblem } from './paths.js';
import { hashBytes } from './capture.js';

type Code = { code?: string };
const codeOf = (cause: unknown) => (cause as Code | undefined)?.code;

export function createNativeFileBoundary(root: string): FileBoundary {
	const scratch = join(root, '.git', 'epicenter', 'scratch');
	const absolute = (path: string) => join(root, ...path.split('/'));

	function invalid(path: string): Result<never, FileError> | undefined {
		const problem = pathProblem(path);
		return problem === undefined
			? undefined
			: FileError.InvalidPath({ path, reason: problem });
	}

	/**
	 * Verify each component's literal spelling and that nothing on the way is
	 * a symbolic link, so a case-insensitive filesystem cannot alias another
	 * name and a link cannot escape the folder.
	 */
	async function verifyLiteral(
		path: string,
	): Promise<Result<'file' | 'directory' | 'absent', FileError>> {
		const parts = path.split('/');
		let directory = root;
		for (let index = 0; index < parts.length; index++) {
			const name = parts[index]!;
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT') return Ok('absent');
				if (codeOf(cause) === 'ENOTDIR')
					return FileError.NotADirectory({
						path: parts.slice(0, index).join('/'),
					});
				return FileError.Io({
					path,
					operation: 'list the directory of',
					cause,
				});
			}
			if (!names.includes(name)) return Ok('absent');
			const next = join(directory, name);
			let stats: Awaited<ReturnType<typeof lstat>>;
			try {
				stats = await lstat(next);
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT') return Ok('absent');
				return FileError.Io({ path, operation: 'inspect', cause });
			}
			if (stats.isSymbolicLink())
				return FileError.InvalidPath({
					path,
					reason: 'the path passes through a symbolic link',
				});
			const last = index === parts.length - 1;
			if (last) return Ok(stats.isDirectory() ? 'directory' : 'file');
			if (!stats.isDirectory())
				return FileError.NotADirectory({
					path: parts.slice(0, index + 1).join('/'),
				});
			directory = next;
		}
		return Ok('absent');
	}

	async function readCurrent(
		path: string,
	): Promise<Result<FileRead | undefined, FileError>> {
		const { data: kind, error: kindError } = await verifyLiteral(path);
		if (kindError !== null) return Err(kindError);
		if (kind === 'absent') return Ok(undefined);
		if (kind === 'directory') return FileError.NotAFile({ path });
		try {
			const bytes = new Uint8Array(await readFile(absolute(path)));
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return Ok(undefined);
			return FileError.Io({ path, operation: 'read', cause });
		}
	}

	async function ensureParent(
		path: string,
	): Promise<Result<undefined, FileError>> {
		for (const parent of ancestors(path)) {
			const { data: kind, error: kindError } = await verifyLiteral(parent);
			if (kindError !== null) return Err(kindError);
			if (kind === 'file') return FileError.NotADirectory({ path: parent });
			if (kind === 'absent') {
				try {
					await mkdir(absolute(parent));
				} catch (cause) {
					if (codeOf(cause) !== 'EEXIST')
						return FileError.Io({ path: parent, operation: 'create', cause });
				}
			}
		}
		return Ok(undefined);
	}

	async function scratchFile(bytes: Uint8Array): Promise<string> {
		await mkdir(scratch, { recursive: true });
		const file = join(
			scratch,
			`${Date.now().toString(36)}-${crypto.randomUUID()}`,
		);
		await writeFile(file, bytes, { flag: 'wx' });
		return file;
	}

	function conflict(
		path: string,
		expectedSha256: string,
		actualSha256: string | undefined,
	) {
		return FileError.Conflict({ path, expectedSha256, actualSha256 });
	}

	/**
	 * A replacement needs a file at the path, guarded or not; with a baseline
	 * the file's bytes must also hash to it.
	 */
	function replaceable(
		path: string,
		expectedSha256: string | undefined,
		current: { sha256: string } | undefined,
	) {
		if (expectedSha256 !== undefined) {
			if (current?.sha256 !== expectedSha256)
				return conflict(path, expectedSha256, current?.sha256);
			return undefined;
		}
		if (current === undefined) return FileError.NotFound({ path });
		return undefined;
	}

	/**
	 * Apply one change. A move is two filesystem steps; when its destination
	 * link lands but retiring the source fails, `landed` receives the
	 * destination write so the caller reports it instead of an ordinary error.
	 */
	async function step(
		change: FileChange,
		landed: FileStep[],
	): Promise<Result<undefined, FileError>> {
		if (
			change.kind === 'create' ||
			change.kind === 'replace' ||
			change.kind === 'overwrite'
		) {
			const { data: current, error: readError } = await readCurrent(
				change.path,
			);
			if (readError !== null) return Err(readError);
			if (change.kind === 'create' && current !== undefined)
				return FileError.Exists({ path: change.path });
			if (change.kind === 'replace') {
				const refused = replaceable(
					change.path,
					change.expectedSha256,
					current,
				);
				if (refused !== undefined) return refused;
			}
			const parent = await ensureParent(change.path);
			if (parent.error !== null) return parent;
			let temporary: string;
			try {
				temporary = await scratchFile(change.bytes);
			} catch (cause) {
				return FileError.Io({
					path: change.path,
					operation: 'stage bytes for',
					cause,
				});
			}
			try {
				// Staging and parent creation took time. Check the sha256 again so
				// the only unchecked window left is this read to the rename below.
				if (change.kind === 'replace') {
					const { data: now, error: rereadError } = await readCurrent(
						change.path,
					);
					if (rereadError !== null) return Err(rereadError);
					const refused = replaceable(change.path, change.expectedSha256, now);
					if (refused !== undefined) return refused;
				}
				if (change.kind === 'create') {
					// Exclusive creation: link fails instead of replacing a newcomer.
					try {
						await link(temporary, absolute(change.path));
					} catch (cause) {
						if (codeOf(cause) === 'EEXIST') {
							return FileError.Exists({ path: change.path });
						}
						return FileError.Io({
							path: change.path,
							operation: 'create',
							cause,
						});
					}
				} else {
					try {
						await rename(temporary, absolute(change.path));
					} catch (cause) {
						return FileError.Io({
							path: change.path,
							operation: 'replace',
							cause,
						});
					}
				}
			} finally {
				await unlink(temporary).catch(() => {});
			}
			return Ok(undefined);
		}
		if (change.kind === 'remove') {
			const { data: current, error: readError } = await readCurrent(
				change.path,
			);
			if (readError !== null) return Err(readError);
			if (current === undefined)
				return FileError.NotFound({ path: change.path });
			if (
				change.expectedSha256 !== undefined &&
				current.sha256 !== change.expectedSha256
			)
				return conflict(change.path, change.expectedSha256, current.sha256);
			try {
				await unlink(absolute(change.path));
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT')
					return FileError.NotFound({ path: change.path });
				return FileError.Io({ path: change.path, operation: 'remove', cause });
			}
			return Ok(undefined);
		}
		const { data: current, error: readError } = await readCurrent(change.from);
		if (readError !== null) return Err(readError);
		if (current === undefined) return FileError.NotFound({ path: change.from });
		if (
			change.expectedSha256 !== undefined &&
			current.sha256 !== change.expectedSha256
		)
			return conflict(change.from, change.expectedSha256, current.sha256);
		const { data: destination, error: destinationError } = await verifyLiteral(
			change.to,
		);
		if (destinationError !== null) return Err(destinationError);
		if (destination === 'directory')
			return FileError.NotAFile({ path: change.to });
		if (destination === 'file') {
			return FileError.Exists({ path: change.to });
		}
		const parent = await ensureParent(change.to);
		if (parent.error !== null) return parent;
		if (change.expectedSha256 !== undefined) {
			// The destination checks took time; the link must carry the bytes checked.
			const { data: now, error: rereadError } = await readCurrent(change.from);
			if (rereadError !== null) return Err(rereadError);
			if (now?.sha256 !== change.expectedSha256)
				return conflict(change.from, change.expectedSha256, now?.sha256);
		}
		try {
			await link(absolute(change.from), absolute(change.to));
		} catch (cause) {
			if (codeOf(cause) === 'EEXIST') {
				return FileError.Exists({ path: change.to });
			}
			return FileError.Io({ path: change.to, operation: 'move to', cause });
		}
		landed.push({ kind: 'write', path: change.to });
		try {
			await unlink(absolute(change.from));
		} catch (cause) {
			// Both paths now hold the bytes; nothing is rolled back.
			return FileError.Io({ path: change.from, operation: 'retire', cause });
		}
		return Ok(undefined);
	}

	// Batches and captures from this boundary run in arrival order. One that
	// fails or throws releases the next.
	let tail: Promise<unknown> = Promise.resolve();
	function inOrder<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work, work);
		tail = result.catch(() => {});
		return result;
	}

	function toStep(change: FileChange): FileStep {
		return change.kind === 'move'
			? { kind: 'move', from: change.from, to: change.to }
			: {
					kind: change.kind === 'remove' ? 'remove' : 'write',
					path: change.path,
				};
	}

	async function walk(
		directory: string,
		prefix: string,
		files: { path: string; size: number }[],
		directories: string[],
	) {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (prefix === '' && entry.name === '.git') continue;
			if (entry.isDirectory()) {
				directories.push(path);
				await walk(join(directory, entry.name), path, files, directories);
			} else if (entry.isFile()) {
				const stats = await lstat(join(directory, entry.name));
				files.push({ path, size: stats.size });
			}
		}
	}

	async function list(): Promise<Result<FileListing, FileError>> {
		const files: { path: string; size: number }[] = [];
		const directories: string[] = [];
		try {
			await walk(root, '', files, directories);
		} catch (cause) {
			return FileError.Io({ path: '', operation: 'enumerate', cause });
		}
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const listing: FileListing = { files, directories: directories.sort() };
		return Ok(listing);
	}

	async function children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>> {
		if (directory !== '') {
			const refused = invalid(directory);
			if (refused) return refused;
			const { data: kind, error: kindError } = await verifyLiteral(directory);
			if (kindError !== null) return Err(kindError);
			if (kind === 'absent') return FileError.NotFound({ path: directory });
			if (kind === 'file') return FileError.NotADirectory({ path: directory });
		}
		try {
			const entries = await readdir(
				directory === '' ? root : absolute(directory),
				{ withFileTypes: true },
			);
			const files: string[] = [];
			const directories: string[] = [];
			for (const entry of entries) {
				if (directory === '' && entry.name === '.git') continue;
				if (entry.isFile()) files.push(entry.name);
				else if (entry.isDirectory()) directories.push(entry.name);
			}
			return Ok({ files: files.sort(), directories: directories.sort() });
		} catch (cause) {
			return FileError.Io({ path: directory, operation: 'list', cause });
		}
	}

	return {
		list,
		children,
		async read(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const { data: current, error: readError } = await readCurrent(path);
			if (readError !== null) return Err(readError);
			if (current === undefined) return FileError.NotFound({ path });
			return Ok(current);
		},
		async readMany(paths) {
			const results = new Map<string, Result<FileRead, FileError>>();
			for (const path of paths) results.set(path, await this.read(path));
			return Ok(results);
		},
		async open(path) {
			// The bytes are copied into memory, so replacing the path later does not
			// change what the consumer receives (ADR-0466).
			const { data: read, error: readError } = await this.read(path);
			if (readError !== null) return Err(readError);
			return Ok(new Blob([read.bytes as Uint8Array<ArrayBuffer>]));
		},
		async apply(changes) {
			for (const change of changes) {
				const paths =
					change.kind === 'move' ? [change.from, change.to] : [change.path];
				for (const path of paths) {
					const refused = invalid(path);
					if (refused) return refused;
				}
			}
			return inOrder(async () => {
				const applied: FileStep[] = [];
				for (let index = 0; index < changes.length; index++) {
					const change = changes[index]!;
					const landed: FileStep[] = [];
					const { error: stepError } = await step(change, landed);
					if (stepError !== null) {
						const reached = [...applied, ...landed];
						// A refusal before anything landed wrote nothing; report it directly.
						if (reached.length === 0) return Err(stepError);
						return ApplyError.Partial({
							applied: reached,
							// A move whose destination landed failed at retiring its source.
							failed:
								landed.length > 0 && change.kind === 'move'
									? { kind: 'remove', path: change.from }
									: toStep(change),
							error: stepError,
							notAttempted: changes.slice(index + 1).map(toStep),
						});
					}
					applied.push(toStep(change));
				}
				return Ok(undefined);
			});
		},
		async mkdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const parent = await ensureParent(`${path}/x`);
			if (parent.error !== null) return parent;
			return Ok(undefined);
		},
		async rmdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const { data: kind, error: kindError } = await verifyLiteral(path);
			if (kindError !== null) return Err(kindError);
			if (kind === 'absent') return FileError.NotFound({ path });
			if (kind === 'file') return FileError.NotADirectory({ path });
			try {
				await rmdir(absolute(path));
				return Ok(undefined);
			} catch (cause) {
				if (codeOf(cause) === 'ENOTEMPTY' || codeOf(cause) === 'EEXIST')
					return FileError.DirectoryNotEmpty({ path });
				return FileError.Io({ path, operation: 'remove directory', cause });
			}
		},
		async capture() {
			// Enumeration and every read share one turn with this boundary's
			// batches. A rename landing between the two would otherwise leave the
			// old path unreadable and the new path never enumerated.
			return inOrder(async () => {
				const { data: listing, error: listError } = await list();
				if (listError !== null) return Err(listError);
				const files = new Map<string, Uint8Array>();
				const unreadable: { path: string; error: FileError }[] = [];
				for (const { path } of listing.files) {
					if (!isPortablePath(path)) continue;
					try {
						files.set(path, new Uint8Array(await readFile(absolute(path))));
					} catch (cause) {
						// Another program removed it after enumeration: absent from this capture.
						if (codeOf(cause) === 'ENOENT') continue;
						unreadable.push({
							path,
							error: FileError.Io({ path, operation: 'read', cause }).error,
						});
					}
				}
				const captured: CapturedFiles = { files, unreadable };
				return Ok(captured);
			});
		},
	};
}

/** Resolve the folder root once, refusing a path that is not a directory. */
export async function resolveNativeRoot(root: string): Promise<string> {
	const resolved = await realpath(root);
	const stats = await lstat(resolved);
	if (!stats.isDirectory())
		throw new Error(`The native folder root '${root}' is not a directory.`);
	return resolved;
}

/**
 * Refuse a root whose private Git state would send writes somewhere else:
 * `.git` as a symbolic link or a `gitdir:` file (a linked worktree or
 * submodule), and a linked `.git/epicenter` or scratch directory. Scratch
 * files are renamed into the folder, so they must live inside it.
 *
 * This inspects the layout once, when the folder opens. It does not defend
 * against a program that swaps a link in afterward.
 */
export async function verifyNativeLayout(root: string): Promise<void> {
	for (const [relative, label] of [
		['.git', '.git'],
		[join('.git', 'epicenter'), '.git/epicenter'],
		[join('.git', 'epicenter', 'scratch'), '.git/epicenter/scratch'],
	] as const) {
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(join(root, relative));
		} catch (cause) {
			// Nothing below an absent directory exists yet; opening creates it.
			if (codeOf(cause) === 'ENOENT') return;
			throw cause;
		}
		if (stats.isSymbolicLink())
			throw new Error(
				`The native folder '${root}' cannot be opened: ${label} is a symbolic link.`,
			);
		if (!stats.isDirectory())
			throw new Error(
				relative === '.git'
					? `The native folder '${root}' cannot be opened: .git is a file that points at another Git directory.`
					: `The native folder '${root}' cannot be opened: ${label} is not a directory.`,
			);
	}
}
