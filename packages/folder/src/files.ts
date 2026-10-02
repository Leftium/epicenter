/** Ordinary file methods over the folder's accounted storage. */
import { Ok, type Result } from 'wellcrafted/result';
import type {
	FileListing,
	FileWriteIntent,
	FolderStorage,
} from './boundary.js';
import {
	type CapturedFile,
	type FileCapture,
	fileCapture,
	hashBytes,
	ownBytes,
	ownCapture,
} from './capture.js';
import type { ApplyError, FileError } from './errors.js';

/**
 * Ordinary files at literal folder-relative paths (ADR-0479).
 *
 * The verb states the condition a save publishes under. Strings are saved as
 * UTF-8 with nothing added or normalized; byte arrays are copied when the
 * method is called and saved exactly. A successful save returns a new
 * capture of the bytes it was given: nothing is read back, and the capture
 * that was passed in never changes.
 */
export type FolderFiles = {
	list(): Promise<Result<FileListing, FileError>>;
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	/** The file's bytes, detached from storage, with the capture that identifies them. */
	read(path: string): Promise<Result<CapturedFile, FileError>>;
	/** Stable bytes for consumption (ADR-0466). */
	open(path: string): Promise<Result<Blob, FileError>>;
	/** Save a new file. Refused when anything is already at the path. */
	create(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	/** Save over the captured file. Refused when its bytes are no longer the captured ones. */
	replace(
		file: FileCapture,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	/** Remove the captured file. Refused when its bytes are no longer the captured ones. */
	remove(file: FileCapture): Promise<Result<undefined, FileError | ApplyError>>;
	/**
	 * Move the captured file to an unoccupied path. The returned capture is the
	 * same content hash at the destination.
	 */
	move(
		file: FileCapture,
		destination: string,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	/** Save at the path whatever is there, as a shell redirection does. */
	overwrite(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError | ApplyError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

export function createFiles({
	storage,
}: {
	storage: FolderStorage;
}): FolderFiles {
	/** Publish one write and return the capture of the bytes that were given. */
	async function save(
		intent: FileWriteIntent,
	): Promise<Result<FileCapture, FileError | ApplyError>> {
		const sha256 = await hashBytes(intent.bytes);
		const applied = await storage.apply([{ ...intent, sha256 }]);
		return applied.error ? applied : Ok(fileCapture(intent.path, sha256));
	}

	return Object.freeze({
		list: () => storage.list(),
		children: (directory) => storage.children(directory),
		async read(path) {
			const read = await storage.read(path);
			if (read.error) return read;
			return Ok(
				Object.freeze({
					...fileCapture(path, read.data.sha256),
					bytes: read.data.bytes,
				}),
			);
		},
		open: (path) => storage.open(path),
		create: (path, content) =>
			save({ kind: 'create', path, bytes: ownBytes(content) }),
		replace: (file, content) => {
			const captured = ownCapture(file);
			if (captured.error) return Promise.resolve(captured);
			// The baseline is fixed here: the capture's own hash, copied.
			const { path, sha256 } = captured.data;
			return save({
				kind: 'replace',
				path,
				bytes: ownBytes(content),
				expectedSha256: sha256,
			});
		},
		remove: (file) => {
			const captured = ownCapture(file);
			if (captured.error) return Promise.resolve(captured);
			const { path, sha256 } = captured.data;
			return storage.apply([{ kind: 'remove', path, expectedSha256: sha256 }]);
		},
		move: async (file, destination) => {
			const captured = ownCapture(file);
			if (captured.error) return captured;
			const { path, sha256 } = captured.data;

			const applied = await storage.apply([
				{ kind: 'move', from: path, to: destination, expectedSha256: sha256 },
			]);
			// A move carries the captured bytes, so their hash is the capture's.
			return applied.error ? applied : Ok(fileCapture(destination, sha256));
		},
		overwrite: (path, content) =>
			save({ kind: 'overwrite', path, bytes: ownBytes(content) }),
		mkdir: (path) => storage.mkdir(path),
		rmdir: (path) => storage.rmdir(path),
	} satisfies FolderFiles);
}
